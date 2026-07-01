'use strict';

// ── easePDF backend ──────────────────────────────────────────────────────
// A tiny Express service that runs two native engines:
//   • Tesseract   — OCR for scanned PDFs and images (POST /ocr)
//   • pdf2docx    — layout-aware PDF→DOCX conversion (POST /pdf-to-docx)
//
// Both endpoints follow the same pattern: rate-limited multipart upload,
// per-request tmp dir, generic error messages to clients (full detail in
// server logs only).
//
// Endpoints:
//   GET  /health        → "ok"          (used by the keep-alive cron)
//   POST /ocr           → multipart      field "file", optional "lang",
//                                         optional "format" ("text" default,
//                                         or "words" for positional TSV data
//                                         with per-word bboxes).
//                         text  format → { engine, lang, pages: [...], text }
//                         words format → { engine, lang, format, pages: [
//                                          { width, height, words: [
//                                            { str, x, y, w, h }
//                                          ] }
//                                        ] }
//   POST /pdf-to-docx   → multipart      field "file"
//                         returns the converted .docx as a binary stream

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
// Defaults tuned for Render's 512 MB free tier. pdf2docx + PyMuPDF + opencv
// can easily peak past 300 MB on a complex PDF, and Tesseract holds the whole
// rasterized page image in memory, so we cap inputs conservatively.
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '25', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '20', 10);
const DPI = parseInt(process.env.OCR_DPI || '200', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10); // OCR requests/min/IP
const CONVERT_RATE_MAX = parseInt(process.env.CONVERT_RATE_MAX || '10', 10); // PDF→DOCX requests/min/IP
const CONVERT_TIMEOUT_MS = parseInt(process.env.CONVERT_TIMEOUT_MS || '120000', 10); // 2 min cap per conversion
const EXEC_BUFFER = 1024 * 1024 * 128; // 128 MB stdout cap for tesseract/pdftoppm/pdf2docx

// Languages we ship traineddata for — MUST match the tesseract-ocr-* packages
// installed in the Dockerfile and the language dropdown in the frontend.
const SUPPORTED_LANGS = new Set([
  'eng', 'spa', 'fra', 'deu', 'ita', 'por',
  'nld', 'hin', 'rus', 'ara', 'chi_sim', 'jpn'
]);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render runs behind a proxy — needed for correct client IPs
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS']
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 }
});

// Rate limit the expensive OCR endpoint (per IP). Returns 429 + Retry-After.
const ocrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OCR requests — please wait a minute and try again.' }
});

// Separate limiter for /pdf-to-docx — pdf2docx is heavier so we cap tighter.
const convertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CONVERT_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many conversion requests — please wait a minute and try again.' }
});

app.get('/health', (req, res) => res.type('text/plain').send('ok'));
app.get('/', (req, res) =>
  res.type('text/plain').send('easePDF backend — POST /ocr or /pdf-to-docx (multipart field "file").'));

app.post('/ocr', ocrLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded — use multipart field name "file".' });
  }

  // Normalise + validate languages (allow "eng+deu" style combos).
  const requested = String(req.body.lang || 'eng').toLowerCase().split('+');
  const langs = requested.filter(l => SUPPORTED_LANGS.has(l));
  const lang = (langs.length ? langs : ['eng']).join('+');

  const format = String(req.body.format || 'text').toLowerCase();
  if (format !== 'text' && format !== 'words') {
    return res.status(400).json({ error: 'Unknown format — use "text" (default) or "words".' });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  try {
    const ext = (path.extname(req.file.originalname) || '').toLowerCase();
    const isPdf = ext === '.pdf' || req.file.mimetype === 'application/pdf';

    // Collect the list of image files to OCR (one for images, N for PDFs).
    let imagePaths;
    if (isPdf) {
      const pdfPath = path.join(workDir, 'input.pdf');
      await fs.writeFile(pdfPath, req.file.buffer);

      // Rasterise every page to PNG: page-1.png, page-2.png, …
      const prefix = path.join(workDir, 'page');
      await execFileAsync('pdftoppm', ['-r', String(DPI), '-png', pdfPath, prefix], { maxBuffer: EXEC_BUFFER });

      let files = (await fs.readdir(workDir))
        .filter(f => f.startsWith('page') && f.endsWith('.png'))
        .sort((a, b) => pageNum(a) - pageNum(b));

      if (files.length === 0) throw new Error('Could not rasterise any PDF pages.');
      if (files.length > MAX_PAGES) files = files.slice(0, MAX_PAGES);
      imagePaths = files.map(f => path.join(workDir, f));
    } else {
      const imgPath = path.join(workDir, 'input' + (ext || '.png'));
      await fs.writeFile(imgPath, req.file.buffer);
      imagePaths = [imgPath];
    }

    if (format === 'words') {
      const pages = [];
      for (const p of imagePaths) pages.push(await runTesseractTsv(p, lang));
      res.json({ engine: 'tesseract-native', lang, format, pages });
    } else {
      const pageTexts = [];
      for (const p of imagePaths) pageTexts.push((await runTesseract(p, lang)).trim());
      res.json({ engine: 'tesseract-native', lang, pages: pageTexts, text: pageTexts.join('\n\n') });
    }
  } catch (err) {
    console.error('[ocr] failed:', err); // full detail in server logs only
    res.status(500).json({ error: 'OCR processing failed. Please try a different file or try again later.' });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// POST /pdf-to-docx — layout-aware PDF→DOCX conversion via pdf2docx.
// Returns the .docx binary directly (Content-Disposition: attachment).
//
// We use pdf2docx (Python) rather than LibreOffice because LibreOffice's
// PDF-import filter reconstructs the page as absolutely-positioned text
// frames — visually accurate in Draw, but exporting that to DOCX produces
// stacks of overlapping frames in Word. pdf2docx does real layout analysis
// (text blocks, tables, columns) and emits a proper Word document.
app.post('/pdf-to-docx', convertLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded — use multipart field name "file".' });
  }
  const ext = (path.extname(req.file.originalname) || '').toLowerCase();
  const isPdf = ext === '.pdf' || req.file.mimetype === 'application/pdf';
  if (!isPdf) {
    return res.status(400).json({ error: 'Expected a PDF file.' });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2docx-'));
  try {
    const inputPath = path.join(workDir, 'input.pdf');
    const outputPath = path.join(workDir, 'output.docx');
    await fs.writeFile(inputPath, req.file.buffer);

    // Cheap page-count check via pdfinfo (already in poppler-utils). Rejecting
    // an oversized PDF here costs ~10ms; letting it into pdf2docx costs the
    // entire container's memory ceiling and may OOM-kill the instance.
    try {
      const { stdout: infoOut } = await execFileAsync('pdfinfo', [inputPath], { maxBuffer: 1024 * 64 });
      const pagesMatch = /^Pages:\s*(\d+)/m.exec(infoOut);
      const pageCount = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;
      if (pageCount > MAX_PAGES) {
        return res.status(413).json({
          error: `PDF has ${pageCount} pages — this server caps conversions at ${MAX_PAGES} pages. Split the PDF first or run this locally.`
        });
      }
    } catch { /* if pdfinfo fails, let pdf2docx try anyway */ }

    const { stdout, stderr } = await execFileAsync('pdf2docx', [
      'convert', inputPath, outputPath
    ], { maxBuffer: EXEC_BUFFER, timeout: CONVERT_TIMEOUT_MS });

    // pdf2docx normally raises on failure (non-zero exit), but guard the
    // read anyway so any silent no-op surfaces a clean error rather than
    // a bare ENOENT.
    let docxBytes;
    try {
      docxBytes = await fs.readFile(outputPath);
    } catch {
      console.error('[pdf-to-docx] pdf2docx exited 0 but produced no output.',
        '\n  stdout:', stdout, '\n  stderr:', stderr);
      throw new Error('Conversion produced no output file — the PDF may be encrypted, image-only, or use unsupported features.');
    }

    // Build a download filename based on the user's original name, sanitised.
    const baseName = (req.file.originalname || 'converted.pdf').replace(/\.[^./\\]+$/, '');
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'converted';

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.send(docxBytes);
  } catch (err) {
    console.error('[pdf-to-docx] failed:', err); // full detail in server logs only
    res.status(500).json({
      error: 'PDF conversion failed. The file may be password-protected, corrupt, or use unsupported features.'
    });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Multer / generic error handler (e.g. file too large).
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large — max ${MAX_FILE_MB} MB.` });
  }
  console.error('[error]', err); // full detail in server logs only
  res.status(500).json({ error: 'Server error.' });
});

function pageNum(filename) {
  const m = filename.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function runTesseract(imgPath, lang) {
  const { stdout } = await execFileAsync('tesseract', [imgPath, 'stdout', '-l', lang], { maxBuffer: EXEC_BUFFER });
  return stdout || '';
}

// TSV output for positional data. Columns (tab-separated, one header row):
//   level, page_num, block_num, par_num, line_num, word_num,
//   left, top, width, height, conf, text
// level 1 = page (has full width/height), level 5 = individual word.
async function runTesseractTsv(imgPath, lang) {
  const { stdout } = await execFileAsync(
    'tesseract', [imgPath, 'stdout', '-l', lang, 'tsv'],
    { maxBuffer: EXEC_BUFFER }
  );
  const lines = (stdout || '').split('\n');
  let width = 0, height = 0;
  const words = [];
  // skip header
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) continue;
    const level = cols[0];
    if (level === '1') {
      width = parseInt(cols[8], 10) || width;
      height = parseInt(cols[9], 10) || height;
    } else if (level === '5') {
      const conf = parseFloat(cols[10]);
      const text = cols[11];
      if (conf > 0 && text && text.trim()) {
        words.push({
          str: text,
          x: parseInt(cols[6], 10),
          y: parseInt(cols[7], 10),
          w: parseInt(cols[8], 10),
          h: parseInt(cols[9], 10)
        });
      }
    }
  }
  return { width, height, words };
}

// Bind explicitly to 0.0.0.0 so Render's IPv4 port scanner sees us. Without a
// host arg Node uses `::` (IPv6 dual-stack) which usually works but has been
// flaky on Render — the port scan can time out even when the process is up.
app.listen(PORT, '0.0.0.0', () => console.log(`easePDF backend listening on 0.0.0.0:${PORT}`));

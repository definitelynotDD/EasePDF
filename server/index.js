'use strict';

// ── easePDF backend ──────────────────────────────────────────────────────
// A tiny Express service that runs two native engines:
//   • Tesseract   — OCR for scanned PDFs and images (POST /ocr)
//   • LibreOffice — exact PDF→DOCX conversion        (POST /pdf-to-docx)
//
// Both endpoints follow the same pattern: rate-limited multipart upload,
// per-request tmp dir, generic error messages to clients (full detail in
// server logs only).
//
// Endpoints:
//   GET  /health        → "ok"          (used by the keep-alive cron)
//   POST /ocr           → multipart      field "file", optional "lang"
//                         returns { engine, lang, pages: [...], text }
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
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '50', 10);
const DPI = parseInt(process.env.OCR_DPI || '300', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10); // OCR requests/min/IP
const CONVERT_RATE_MAX = parseInt(process.env.CONVERT_RATE_MAX || '10', 10); // PDF→DOCX requests/min/IP
const CONVERT_TIMEOUT_MS = parseInt(process.env.CONVERT_TIMEOUT_MS || '120000', 10); // 2 min cap per conversion
const EXEC_BUFFER = 1024 * 1024 * 128; // 128 MB stdout cap for tesseract/pdftoppm/libreoffice

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

// Separate limiter for /pdf-to-docx — LibreOffice is heavier so we cap tighter.
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

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  try {
    const ext = (path.extname(req.file.originalname) || '').toLowerCase();
    const isPdf = ext === '.pdf' || req.file.mimetype === 'application/pdf';
    const pageTexts = [];

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

      for (const f of files) {
        pageTexts.push((await runTesseract(path.join(workDir, f), lang)).trim());
      }
    } else {
      const imgPath = path.join(workDir, 'input' + (ext || '.png'));
      await fs.writeFile(imgPath, req.file.buffer);
      pageTexts.push((await runTesseract(imgPath, lang)).trim());
    }

    res.json({ engine: 'tesseract-native', lang, pages: pageTexts, text: pageTexts.join('\n\n') });
  } catch (err) {
    console.error('[ocr] failed:', err); // full detail in server logs only
    res.status(500).json({ error: 'OCR processing failed. Please try a different file or try again later.' });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// POST /pdf-to-docx — exact PDF→DOCX conversion via headless LibreOffice.
// Returns the .docx binary directly (Content-Disposition: attachment).
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
    await fs.writeFile(inputPath, req.file.buffer);

    // Per-request UserInstallation profile prevents lock contention when two
    // concurrent requests hit the shared default profile. Costs ~3-5s of
    // first-time profile setup per call, but the build-time pre-warm copy
    // already populated the registry templates so it's mostly directory I/O.
    //
    // --infilter="writer_pdf_import" is REQUIRED: without it LibreOffice
    // opens PDFs in Draw (the default handler), Draw has no DOCX export
    // filter, and the command exits 0 with no output file — so the readFile
    // below fails with ENOENT. Forcing the Writer PDF-import filter routes
    // the file through Writer, which does have the DOCX export filter.
    const profileDir = path.join(workDir, 'lo-profile');
    const { stdout: loStdout, stderr: loStderr } = await execFileAsync('libreoffice', [
      `-env:UserInstallation=file://${profileDir}`,
      '--headless',
      '--infilter=writer_pdf_import',
      '--convert-to', 'docx',
      '--outdir', workDir,
      inputPath
    ], { maxBuffer: EXEC_BUFFER, timeout: CONVERT_TIMEOUT_MS });

    // LibreOffice names the output by stripping the input extension and
    // appending .docx, so input.pdf → input.docx in the same outdir. LO can
    // still exit 0 with no file for some malformed PDFs, so guard the read.
    const outputPath = path.join(workDir, 'input.docx');
    let docxBytes;
    try {
      docxBytes = await fs.readFile(outputPath);
    } catch {
      console.error('[pdf-to-docx] LibreOffice exited 0 but produced no output.',
        '\n  stdout:', loStdout, '\n  stderr:', loStderr);
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

app.listen(PORT, () => console.log(`easePDF OCR backend listening on :${PORT}`));

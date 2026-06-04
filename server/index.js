'use strict';

// ── easePDF OCR backend ──────────────────────────────────────────────────
// A tiny Express service that runs the *native* Tesseract engine.
// PDFs are rasterised to PNG pages with poppler (pdftoppm) at a configurable
// DPI, then each page is OCR'd with `tesseract`. Images are OCR'd directly.
//
// Endpoints:
//   GET  /health  → "ok"            (used by the keep-alive cron)
//   POST /ocr     → multipart form  (field "file", optional "lang")
//                   returns { engine, lang, pages: [...], text }

const express = require('express');
const cors = require('cors');
const multer = require('multer');
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
const EXEC_BUFFER = 1024 * 1024 * 128; // 128 MB stdout cap for tesseract/pdftoppm

// Languages we ship traineddata for — MUST match the tesseract-ocr-* packages
// installed in the Dockerfile and the language dropdown in the frontend.
const SUPPORTED_LANGS = new Set([
  'eng', 'spa', 'fra', 'deu', 'ita', 'por',
  'nld', 'hin', 'rus', 'ara', 'chi_sim', 'jpn'
]);

const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS']
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 }
});

app.get('/health', (req, res) => res.type('text/plain').send('ok'));
app.get('/', (req, res) =>
  res.type('text/plain').send('easePDF OCR backend — POST a file to /ocr (field "file").'));

app.post('/ocr', upload.single('file'), async (req, res) => {
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
    console.error('[ocr] failed:', err);
    res.status(500).json({ error: err.message || 'OCR failed.' });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Multer / generic error handler (e.g. file too large).
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large — max ${MAX_FILE_MB} MB.` });
  }
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Server error.' });
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

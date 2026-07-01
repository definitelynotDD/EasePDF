# easePDF backend (native Tesseract + pdf2docx)

A small Express service that runs two native engines:

- **Tesseract** — OCR for scanned PDFs and images (higher accuracy than the
  in-browser WASM build). PDFs are rasterised with poppler (`pdftoppm`) and
  OCR'd page-by-page; images are OCR'd directly.
- **pdf2docx** — layout-aware PDF → DOCX conversion. Analyses text blocks,
  tables, and columns and emits a real Word document. Much better editable
  output than LibreOffice's PDF import (which reconstructs pages as
  positioned frames that overlap when opened in Word).

The frontend uses this backend when `OCR_BACKEND_URL` is set in `js/app.js`,
and automatically falls back to in-browser engines if the server is unreachable
(Tesseract.js for OCR; the built-in text/image extractor for PDF→DOCX).

## API

| Method | Path            | Description |
|--------|-----------------|-------------|
| `GET`  | `/health`       | Returns `ok` (used by the keep-alive cron). |
| `POST` | `/ocr`          | Multipart form: `file` (PDF/JPG/PNG), optional `lang` (e.g. `eng`, `eng+deu`). Returns `{ engine, lang, pages: [...], text }`. |
| `POST` | `/pdf-to-docx`  | Multipart form: `file` (PDF). Returns the converted `.docx` as a binary stream with `Content-Disposition: attachment`. |

## Environment variables

| Var                   | Default   | Notes |
|-----------------------|-----------|-------|
| `PORT`                | `10000`   | Set automatically by Render. |
| `ALLOWED_ORIGIN`      | `*`       | CORS origin(s), comma-separated. Lock to your site in production. |
| `MAX_FILE_MB`         | `50`      | Upload size limit (applies to both endpoints). |
| `MAX_PAGES`           | `50`      | Max PDF pages OCR'd per request. |
| `OCR_DPI`             | `300`     | Rasterisation DPI (higher = more accurate, slower). |
| `RATE_LIMIT_MAX`      | `20`      | Max OCR requests per minute per IP (returns 429 beyond this). |
| `CONVERT_RATE_MAX`    | `10`      | Max PDF→DOCX requests per minute per IP. |
| `CONVERT_TIMEOUT_MS`  | `120000`  | Hard cap per pdf2docx conversion (2 min). |

## Run locally

Requires `tesseract`, `poppler-utils`, and `pdf2docx` (Python) on your machine
(e.g. the [UB-Mannheim Tesseract](https://github.com/UB-Mannheim/tesseract)
build on Windows + `pip install pdf2docx`, or `brew install tesseract poppler
&& pip install pdf2docx` / `apt install tesseract-ocr poppler-utils python3-pip
&& pip3 install pdf2docx`).

```bash
cd server
npm install
npm start            # listens on http://localhost:10000
```

Or with Docker (matches the Render deploy exactly):

```bash
cd server
docker build -t easepdf-ocr .
docker run -p 10000:10000 easepdf-ocr
```

## Deploy to Render (free)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, select the repo.
   Render reads `render.yaml` and builds `server/Dockerfile`.
   (Or **New → Web Service**, set **Root Directory** = `server`, **Runtime** = Docker.)
3. After it deploys you'll get a URL like `https://easepdf-ocr.onrender.com`.
4. Wire it into the frontend:
   - In `js/app.js`, set `OCR_BACKEND_URL` to that URL.
   - In `vercel.json`, add that URL to the CSP `connect-src` directive.
   - Redeploy the frontend.
5. Keep it warm: point an external pinger at `GET /health` every 5 minutes
   (this project uses cron-job.org; UptimeRobot works too).

## Languages (OCR only)

Built-in: `eng, spa, fra, deu, ita, por, nld, hin, rus, ara, chi_sim, jpn`.
To add more, install the matching `tesseract-ocr-<lang>` package in the
`Dockerfile`, add the code to `SUPPORTED_LANGS` in `index.js`, and add an
`<option>` to the language dropdown in `js/app.js`.

## Notes on PDF → DOCX

- `pdf2docx` is a Python library that runs full layout analysis on each
  PDF page (text blocks, tables, columns, images) via PyMuPDF, then emits
  a properly-structured DOCX with real paragraphs and tables.
- Chosen over LibreOffice because LibreOffice's `writer_pdf_import` filter
  reconstructs pages as absolutely-positioned text frames — visually exact
  in Draw, but Word renders those frames overlapping and unreadable.
- Typical conversion time: ~1–3s per page after cold start.
- Adding Python + pdf2docx (with its opencv/PyMuPDF deps) grows the Docker
  image by ~250 MB. One-time cost — Render caches the image between deploys.

### Scanned PDFs

pdf2docx extracts text positions, so on a scanned (image-only) PDF it
produces an empty DOCX. The frontend detects this case with pdf.js
before uploading — if the PDF has no selectable text, it uses the
existing `/ocr` endpoint instead of `/pdf-to-docx`, then builds a DOCX
from the returned per-page text on the client. No server change was
needed to support scanned files.

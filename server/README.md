---
title: easePDF Backend
emoji: 📝
colorFrom: red
colorTo: pink
sdk: docker
app_port: 10000
pinned: false
---

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
| `POST` | `/ocr`          | Multipart form: `file` (PDF/JPG/PNG), optional `lang` (e.g. `eng`, `eng+deu`), optional `format` (`text` default, or `words` for positional data). Text response: `{ engine, lang, pages: [...text], text }`. Words response: `{ engine, lang, format, pages: [{ width, height, words: [{ str, x, y, w, h }] }] }` — used by the tables extractor for OCR-based table detection on scanned PDFs. |
| `POST` | `/pdf-to-docx`  | Multipart form: `file` (PDF). Returns the converted `.docx` as a binary stream with `Content-Disposition: attachment`. |

## Environment variables

| Var                   | Default   | Notes |
|-----------------------|-----------|-------|
| `PORT`                | `10000`   | Set automatically by Render. |
| `ALLOWED_ORIGIN`      | `*`       | CORS origin(s), comma-separated. Lock to your site in production. |
| `MAX_FILE_MB`         | `25`      | Upload size limit (applies to both endpoints). Tuned for Render free tier. |
| `MAX_PAGES`           | `20`      | Max PDF pages per request. `/pdf-to-docx` rejects larger PDFs upfront via `pdfinfo`. |
| `OCR_DPI`             | `200`     | Rasterisation DPI (higher = more accurate, more memory). |
| `RATE_LIMIT_MAX`      | `20`      | Max OCR requests per minute per IP (returns 429 beyond this). |
| `CONVERT_RATE_MAX`    | `10`      | Max PDF→DOCX requests per minute per IP. |
| `CONVERT_TIMEOUT_MS`  | `120000`  | Hard cap per pdf2docx conversion (2 min). |

Defaults above are tuned for **Render's 512 MB free tier**. On a paid plan
with more RAM you can safely raise `MAX_FILE_MB`, `MAX_PAGES`, and `OCR_DPI`
to the previous values (50 / 50 / 300) for larger files and better OCR
accuracy.

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

## Deploy to HuggingFace Spaces (recommended, free)

HuggingFace's free tier gives every Space **much more RAM than Render's free
tier** (typically several GB vs 512 MB), which matters here because pdf2docx +
PyMuPDF + opencv-python-headless have a ~200 MB baseline before doing any real
work. Render's free tier OOMs on modest PDFs; HF Spaces handles them fine.

1. Create an account on [huggingface.co](https://huggingface.co) if you don't have one.
2. Go to [huggingface.co/new-space](https://huggingface.co/new-space):
   - Space name: e.g. `easepdf-backend`
   - License: MIT (or match the repo)
   - SDK: **Docker → Blank**
   - Hardware: **CPU basic** (free)
   - Visibility: Public
3. Copy the contents of this `server/` folder into the new Space's git repo:
   ```bash
   git clone https://huggingface.co/spaces/<your-hf-username>/easepdf-backend
   cd easepdf-backend
   cp -r ../EasePDF/server/* .
   git add .
   git commit -m "Initial deploy"
   git push
   ```
   The push triggers a build; HF reads the YAML frontmatter at the top of this
   README to know the port and SDK.
4. First build takes ~10–15 min (installs Tesseract, poppler, pdf2docx). Once
   it goes green, your backend is live at
   `https://<your-hf-username>-easepdf-backend.hf.space`.
5. Wire it into the frontend:
   - In `js/app.js`, set `OCR_BACKEND_URL` to that URL.
   - In `vercel.json`, add that URL to the CSP `connect-src` directive.
   - Redeploy the frontend.
6. Keep it warm: point an external pinger at `GET /health` every 5 minutes
   (this project uses cron-job.org; UptimeRobot works too). HF Spaces sleep
   after ~48h of inactivity on free tier.

### Alternative: deploy to Render (free tier — OOM warning)

Render's free tier has a 512 MB memory ceiling that pdf2docx blows past on
non-trivial PDFs. If you deploy here anyway (perhaps just for OCR without the
PDF→DOCX endpoint), the same Dockerfile works:

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, select the repo.
   Render reads `render.yaml` and builds `server/Dockerfile`.
3. After it deploys you'll get a URL like `https://<name>.onrender.com`.
4. Wire it into the frontend as in step 5 above.
5. Keep warm as in step 6 above.

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

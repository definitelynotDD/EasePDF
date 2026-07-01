# easePDF backend (native Tesseract + LibreOffice)

A small Express service that runs two native engines:

- **Tesseract** — OCR for scanned PDFs and images (higher accuracy than the
  in-browser WASM build). PDFs are rasterised with poppler (`pdftoppm`) and
  OCR'd page-by-page; images are OCR'd directly.
- **LibreOffice (headless)** — near-exact PDF → DOCX conversion, preserving
  layout, fonts, tables, and columns better than any client-side heuristic.

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
| `CONVERT_TIMEOUT_MS`  | `120000`  | Hard cap per LibreOffice conversion (2 min). |

## Run locally

Requires `tesseract`, `poppler-utils`, and `libreoffice` on your machine
(e.g. the [UB-Mannheim Tesseract](https://github.com/UB-Mannheim/tesseract)
build + LibreOffice installer on Windows, or `brew install tesseract poppler libreoffice`
/ `apt install tesseract-ocr poppler-utils libreoffice-core libreoffice-writer libreoffice-draw`).

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

- LibreOffice's headless converter is the open-source gold standard for
  PDF → DOCX; it preserves layout, fonts, tables, and columns significantly
  better than any heuristic client-side approach.
- Each request runs LibreOffice with a per-request `UserInstallation`
  profile so concurrent conversions don't block each other on lock files.
- The Docker image pre-warms the default LibreOffice profile at build time
  so the first `/pdf-to-docx` request after deploy isn't slowed by profile
  bootstrap. First request after cold-start still takes ~15–25s (Render
  spin-up + LibreOffice load); subsequent requests are ~3–8s per page.
- Adding LibreOffice grows the Docker image by ~400 MB. This is a one-time
  cost — Render caches the image between deploys.

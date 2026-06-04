# easePDF OCR backend (native Tesseract)

A small Express service that runs the **native Tesseract engine** for higher
accuracy than the in-browser WASM build. PDFs are rasterised with poppler
(`pdftoppm`) and OCR'd page-by-page; images are OCR'd directly.

The frontend uses this backend when `OCR_BACKEND_URL` is set in `js/app.js`,
and automatically falls back to in-browser Tesseract.js if the server is
unreachable.

## API

| Method | Path      | Description |
|--------|-----------|-------------|
| `GET`  | `/health` | Returns `ok` (used by the keep-alive cron). |
| `POST` | `/ocr`    | Multipart form: `file` (PDF/JPG/PNG), optional `lang` (e.g. `eng`, `eng+deu`). Returns `{ engine, lang, pages: [...], text }`. |

## Environment variables

| Var              | Default | Notes |
|------------------|---------|-------|
| `PORT`           | `10000` | Set automatically by Render. |
| `ALLOWED_ORIGIN` | `*`     | CORS origin(s), comma-separated. Lock to your site in production. |
| `MAX_FILE_MB`    | `50`    | Upload size limit. |
| `MAX_PAGES`      | `50`    | Max PDF pages OCR'd per request. |
| `OCR_DPI`        | `300`   | Rasterisation DPI (higher = more accurate, slower). |

## Run locally

Requires `tesseract` and `poppler-utils` on your machine
(e.g. the [UB-Mannheim Tesseract](https://github.com/UB-Mannheim/tesseract)
build on Windows, or `brew install tesseract poppler` / `apt install tesseract-ocr poppler-utils`).

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
5. Keep it warm: set a repo variable `OCR_BACKEND_URL` (Settings → Secrets and
   variables → Actions → Variables) so `.github/workflows/keep-alive.yml` pings
   `/health` every 10 minutes. (Or use an external pinger like UptimeRobot /
   cron-job.org.)

> **Free-tier note:** the instance still cold-starts once after each deploy,
> and the keep-alive ping consumes free instance hours (~720/month for one
> always-on service, under the 750 free hours).

## Languages

Built-in: `eng, spa, fra, deu, ita, por, nld, hin, rus, ara, chi_sim, jpn`.
To add more, install the matching `tesseract-ocr-<lang>` package in the
`Dockerfile`, add the code to `SUPPORTED_LANGS` in `index.js`, and add an
`<option>` to the language dropdown in `js/app.js`.

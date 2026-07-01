# easePDF backend: native Tesseract (OCR) + LibreOffice (PDF→DOCX) on Node.
FROM node:20-slim

# Tesseract + language packs (OCR) + poppler (PDF rasterisation for OCR) +
# LibreOffice (PDF→DOCX conversion). Language packs here MUST match
# SUPPORTED_LANGS in index.js and the language dropdown in the frontend.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-spa \
        tesseract-ocr-fra \
        tesseract-ocr-deu \
        tesseract-ocr-ita \
        tesseract-ocr-por \
        tesseract-ocr-nld \
        tesseract-ocr-hin \
        tesseract-ocr-rus \
        tesseract-ocr-ara \
        tesseract-ocr-chi-sim \
        tesseract-ocr-jpn \
        poppler-utils \
        libreoffice-core \
        libreoffice-writer \
        libreoffice-draw \
    && rm -rf /var/lib/apt/lists/*

# Pre-warm the LibreOffice user profile at build time. Without this the first
# /pdf-to-docx call after deploy spends ~20s creating ~/.config/libreoffice
# before doing any actual conversion work.
RUN mkdir -p /root/.config/libreoffice \
    && printf 'warmup\n' > /tmp/warmup.txt \
    && libreoffice --headless --convert-to docx --outdir /tmp /tmp/warmup.txt \
    && rm -f /tmp/warmup.txt /tmp/warmup.docx

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "index.js"]

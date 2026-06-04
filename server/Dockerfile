# Native Tesseract OCR backend for easePDF Toolkit
FROM node:20-slim

# Tesseract engine + language packs + poppler (for PDF rasterisation).
# Language packs here MUST match SUPPORTED_LANGS in index.js and the
# language dropdown in the frontend.
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "index.js"]

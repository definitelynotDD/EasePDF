# easePDF backend: native Tesseract (OCR) + pdf2docx (PDF→DOCX) on Node.
FROM node:20-slim

# Tesseract + language packs (OCR) + poppler (PDF rasterisation for OCR) +
# Python (for pdf2docx). Language packs here MUST match SUPPORTED_LANGS in
# index.js and the language dropdown in the frontend.
#
# libgl1 + libglib2.0-0 are runtime deps for opencv-python-headless which
# pdf2docx pulls in for layout analysis.
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
        python3 \
        python3-pip \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# pdf2docx is the primary tool for near-exact PDF→DOCX conversion. It
# does real layout analysis (text blocks, tables, columns) instead of
# LibreOffice's PDF-import-via-positioned-frames approach, which produces
# a DOCX that renders as overlapping text in Word.
# --break-system-packages is required on Debian 12 (PEP 668) — this is
# a container, not a shared system, so no risk to a system Python.
RUN pip3 install --no-cache-dir --break-system-packages pdf2docx

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "index.js"]

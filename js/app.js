document.addEventListener('DOMContentLoaded', () => {
    const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js`;

    let currentToolId = null;
    let selectedFiles = [];
    const MAX_FILE_SIZE_MB = 100;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

    // OCR backend (native Tesseract on Render). Leave '' to use the in-browser
    // engine only. Set to your deployed URL, e.g. 'https://easepdf-ocr.onrender.com',
    // and add that origin to connect-src in vercel.json. When set, OCR prefers
    // the server and falls back to in-browser Tesseract.js if it's unreachable.
    const OCR_BACKEND_URL = 'https://easepdf-ocr.onrender.com';

    const PAGE_NUM_STYLES = {
        'page-of':     'Page {page} of {total}',
        'of':          '{page} of {total}',
        'slash':       '{page} / {total}',
        'page-only':   'Page {page}',
        'number-only': '{page}',
        'dashes':      '— {page} —'
    };

    // ── PDF PREVIEW STATE ─────────────────────────────────────────────────
    let previewPDFDoc = null;
    let previewCurrentPage = 1;
    let previewRendering = false;
    let previewPendingPage = null;

    // ── TOOL DEFINITIONS ────────────────────────────────────────────────
    const toolImplementations = {

        'pdf-table-to-excel': {
            title: 'PDF Tables → Excel',
            desc: 'Extract all tables from a PDF and export each as an Excel sheet. OCR fallback for scanned PDFs.',
            icon: '📊',
            category: 'Extract',
            fileType: '.pdf',
            multiple: false,
            badge: 'new',
            options: () => `
                <div class="option-group">
                    <label>Detection sensitivity</label>
                    <div class="range-row">
                        <input type="range" id="tbl-sensitivity" min="1" max="5" step="1" value="3">
                        <span class="range-val" id="tbl-sensitivity-val">3</span>
                    </div>
                    <p style="font-size:.78rem;color:var(--muted);margin-top:4px">Higher = detects more (loosely spaced) tables; may pick up false positives.</p>
                </div>
                <div class="option-group">
                    <label for="tbl-header-row">
                        <input type="checkbox" id="tbl-header-row" checked style="width:auto;margin-right:6px">
                        Use first row as header
                    </label>
                </div>
                <div class="option-group">
                    <label for="tbl-ocr-lang">Document language <span style="color:var(--muted);font-weight:400">(used only if the PDF is scanned)</span></label>
                    <select id="tbl-ocr-lang">
                        <option value="eng">English</option>
                        <option value="spa">Spanish</option>
                        <option value="fra">French</option>
                        <option value="deu">German</option>
                        <option value="ita">Italian</option>
                        <option value="por">Portuguese</option>
                        <option value="nld">Dutch</option>
                        <option value="hin">Hindi</option>
                        <option value="rus">Russian</option>
                        <option value="ara">Arabic</option>
                        <option value="chi_sim">Chinese (Simplified)</option>
                        <option value="jpn">Japanese</option>
                    </select>
                </div>
            `,
            process: async (options) => {
                showLoader('Loading PDF for table extraction…');
                const pdfBytes = await selectedFiles[0].arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
                const numPages = pdf.numPages;
                const sensitivity = parseInt(options['tbl-sensitivity']) || 3;
                const useHeader = options['tbl-header-row'] !== false && options['tbl-header-row'] !== 'false';
                const ocrLang = options['tbl-ocr-lang'] || 'eng';

                const allTables = [];
                const perPageContent = [];
                let totalItems = 0;

                for (let p = 1; p <= numPages; p++) {
                    showLoader(`Scanning page ${p} of ${numPages}…`);
                    const page = await pdf.getPage(p);
                    const content = await page.getTextContent();
                    perPageContent.push(content);
                    totalItems += content.items.length;
                    const tables = extractTablesFromTextContent(content, sensitivity);
                    tables.forEach((t, i) => allTables.push({ pageNum: p, tableIndex: i + 1, rows: t }));
                }

                // OCR fallback: if pdf.js found no text at all, this is almost
                // certainly a scanned PDF. Rasterize + OCR each page and rerun
                // table detection on the OCR words (which have bboxes we can
                // reshape into pdf.js-style positioned items).
                if (allTables.length === 0 && totalItems === 0) {
                    showToast('No selectable text — running OCR, then retrying table detection');
                    try {
                        const ocrContents = await ocrPagesToPositionedItems(selectedFiles[0], pdf, ocrLang);
                        for (let p = 0; p < ocrContents.length; p++) {
                            const tables = extractTablesFromTextContent(ocrContents[p], sensitivity);
                            tables.forEach((t, i) => allTables.push({ pageNum: p + 1, tableIndex: i + 1, rows: t }));
                        }
                    } catch (err) {
                        console.warn('OCR fallback failed:', err);
                        hideLoader();
                        showOutputMessage('⚠️ This looks like a scanned PDF and the OCR fallback failed — check that Tesseract.js can load (cdn.jsdelivr.net must be allowed by CSP).');
                        return;
                    }
                }

                if (allTables.length === 0) {
                    hideLoader();
                    showOutputMessage('⚠️ No tables detected in this PDF. Try increasing sensitivity, or the source may not contain grid-aligned tabular data.');
                    return;
                }

                showLoader(`Building Excel workbook (${allTables.length} table${allTables.length > 1 ? 's' : ''})…`);
                const wb = XLSX.utils.book_new();

                allTables.forEach((tbl) => {
                    const sheetName = `Page${tbl.pageNum}_T${tbl.tableIndex}`.substring(0, 31);
                    let rows = tbl.rows;
                    rows = rows.filter(r => r.some(c => c && c.trim && c.trim() !== ''));
                    const ws = XLSX.utils.aoa_to_sheet(rows);

                    const colWidths = [];
                    rows.forEach(r => r.forEach((cell, ci) => {
                        const len = cell ? String(cell).length : 8;
                        colWidths[ci] = Math.max(colWidths[ci] || 8, Math.min(len, 50));
                    }));
                    ws['!cols'] = colWidths.map(w => ({ wch: w + 2 }));

                    XLSX.utils.book_append_sheet(wb, ws, sheetName);
                });

                const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

                hideLoader();
                renderTablePreview(allTables, useHeader, blob, selectedFiles[0].name);
            }
        },

        'ocr-pdf': {
            title: 'OCR PDF',
            desc: 'Extract text from scanned / image PDFs (and images) using in-browser OCR.',
            icon: '🔍',
            category: 'Extract',
            fileType: '.pdf,.jpg,.jpeg,.png',
            multiple: false,
            badge: 'new',
            options: () => `
                <div class="option-group">
                    <label for="ocr-lang">Document language</label>
                    <select id="ocr-lang">
                        <option value="eng">English</option>
                        <option value="spa">Spanish</option>
                        <option value="fra">French</option>
                        <option value="deu">German</option>
                        <option value="ita">Italian</option>
                        <option value="por">Portuguese</option>
                        <option value="nld">Dutch</option>
                        <option value="hin">Hindi</option>
                        <option value="rus">Russian</option>
                        <option value="ara">Arabic</option>
                        <option value="chi_sim">Chinese (Simplified)</option>
                        <option value="jpn">Japanese</option>
                    </select>
                </div>
                <div class="option-group">
                    <label>Render quality</label>
                    <div class="range-row">
                        <input type="range" id="ocr-scale" min="1" max="4" step="1" value="2">
                        <span class="range-val" id="ocr-scale-val">2</span>
                    </div>
                    <p style="font-size:.78rem;color:var(--muted);margin-top:4px">Higher = sharper input &amp; better accuracy on small text, but slower.</p>
                </div>
                <p style="font-size:.78rem;color:var(--muted)">⚡ The OCR engine &amp; language data download on first run, then everything is processed locally in your browser — nothing is uploaded.</p>
            `,
            process: async (options) => {
                const lang = options['ocr-lang'] || 'eng';
                const scale = parseFloat(options['ocr-scale']) || 2;
                const file = selectedFiles[0];
                const isPdf = file.name.toLowerCase().endsWith('.pdf');

                let pageTexts = null;
                let engine = 'browser'; // which engine actually produced the result

                // 1) Prefer the native Tesseract backend (more accurate) when configured.
                if (OCR_BACKEND_URL) {
                    try {
                        showLoader('Sending to OCR server (native Tesseract)…');
                        pageTexts = await ocrViaBackend(file, lang);
                        engine = 'native';
                    } catch (err) {
                        console.warn('Backend OCR failed — falling back to in-browser engine:', err);
                        showToast('⚠️ OCR server unavailable — using in-browser engine');
                        pageTexts = null;
                    }
                }

                // 2) Fall back to in-browser Tesseract.js (fully client-side).
                if (!pageTexts) {
                    if (typeof Tesseract === 'undefined') {
                        throw new Error('OCR engine (Tesseract.js) could not load — it may be blocked by the page’s Content-Security-Policy. Ensure cdn.jsdelivr.net is allowed.');
                    }
                    showLoader('Loading OCR engine…');
                    const worker = await Tesseract.createWorker(lang, 1, {
                        logger: m => {
                            if (m.status === 'recognizing text') {
                                showLoader(`Recognizing text… ${Math.round((m.progress || 0) * 100)}%`);
                            }
                        }
                    });

                    pageTexts = [];
                    try {
                        if (isPdf) {
                            const bytes = await file.arrayBuffer();
                            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                            for (let i = 1; i <= pdf.numPages; i++) {
                                showLoader(`OCR page ${i} of ${pdf.numPages}…`);
                                const pg = await pdf.getPage(i);
                                const vp = pg.getViewport({ scale });
                                const cv = document.createElement('canvas');
                                cv.width = vp.width; cv.height = vp.height;
                                await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
                                const { data: { text } } = await worker.recognize(cv);
                                pageTexts.push((text || '').trim());
                            }
                        } else {
                            showLoader('Recognizing text…');
                            const url = URL.createObjectURL(file);
                            try {
                                const { data: { text } } = await worker.recognize(url);
                                pageTexts.push((text || '').trim());
                            } finally {
                                URL.revokeObjectURL(url);
                            }
                        }
                    } finally {
                        await worker.terminate();
                    }
                }

                const plainText = pageTexts.join('\n\n');
                if (!plainText.trim()) {
                    hideLoader();
                    showOutputMessage('⚠️ No text could be recognized. Try a higher render quality, a clearer scan, or check the selected language.');
                    return;
                }

                showLoader('Building downloads…');
                const txtBlob = new Blob([plainText], { type: 'text/plain' });
                const paragraphs = plainText.split('\n').map(t => new docx.Paragraph({ children: [new docx.TextRun(t)] }));
                const docxDoc = new docx.Document({ sections: [{ children: paragraphs }] });
                const docxBlob = await docx.Packer.toBlob(docxDoc);

                hideLoader();
                showToast(engine === 'native' ? '✅ OCR done by native Tesseract (server)' : '✅ OCR done by in-browser Tesseract.js');
                renderOcrResult(pageTexts, plainText, txtBlob, docxBlob, file.name, engine);
            }
        },

        'merge-pdf': {
            title: 'Merge PDF',
            desc: 'Combine multiple PDFs into one document.',
            icon: '📚',
            category: 'Organize',
            fileType: '.pdf',
            multiple: true,
            process: async () => {
                showLoader('Merging PDFs…');
                const mergedPdf = await PDFDocument.create();
                for (let i = 0; i < selectedFiles.length; i++) {
                    showLoader(`Processing PDF ${i + 1} of ${selectedFiles.length}…`);
                    const pdfBytes = await selectedFiles[i].arrayBuffer();
                    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                    const copied = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
                    copied.forEach(p => mergedPdf.addPage(p));
                }
                const bytes = await mergedPdf.save();
                hideLoader();
                await showPDFOutputPreview(bytes, 'merged.pdf');
            }
        },

        'split-pdf': {
            title: 'Split PDF',
            desc: 'Extract specific pages from a PDF.',
            icon: '✂️',
            category: 'Organize',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label for="page-range">Page range (e.g. 1-3, 5, 8-10)</label>
                    <input type="text" id="page-range" placeholder="e.g. 1-3, 5">
                </div>
            `,
            process: async (options) => {
                showLoader('Splitting selected PDF pages…');
                const range = options['page-range'];
                if (!range) throw new Error('Page range is required.');
                const pdfBytes = await selectedFiles[0].arrayBuffer();
                const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                const total = pdfDoc.getPageCount();
                const indices = [];
                range.split(',').forEach(part => {
                    if (part.includes('-')) {
                        const [s, e] = part.trim().split('-').map(Number);
                        for (let i = s; i <= e; i++) if (i > 0 && i <= total) indices.push(i - 1);
                    } else {
                        const n = Number(part.trim());
                        if (n > 0 && n <= total) indices.push(n - 1);
                    }
                });
                const uniq = [...new Set(indices)];
                if (!uniq.length) throw new Error('Invalid page range.');
                const newPdf = await PDFDocument.create();
                const copied = await newPdf.copyPages(pdfDoc, uniq);
                copied.forEach(p => newPdf.addPage(p));
                const bytes = await newPdf.save();
                hideLoader();
                await showPDFOutputPreview(bytes, 'split.pdf');
            }
        },

        'compress-pdf': {
            title: 'Compress PDF',
            desc: 'Reduce PDF file size by resampling images.',
            icon: '🗜️',
            category: 'Optimize',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label>Image Quality</label>
                    <div class="range-row">
                        <input type="range" id="quality-slider" min="0.1" max="1.0" step="0.1" value="0.7">
                        <span class="range-val" id="quality-slider-val">0.7</span>
                    </div>
                </div>
            `,
            process: async (options) => {
                const quality = parseFloat(options['quality-slider']);
                const pdfBytes = await selectedFiles[0].arrayBuffer();
                const src = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
                const newDoc = await PDFDocument.create();
                for (let i = 1; i <= src.numPages; i++) {
                    showLoader(`Compressing page ${i}/${src.numPages}…`);
                    const pg = await src.getPage(i);
                    const vp = pg.getViewport({ scale: 1 });
                    const cv = document.createElement('canvas');
                    cv.width = vp.width; cv.height = vp.height;
                    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
                    const imgData = cv.toDataURL('image/jpeg', quality);
                    const imgBytes = dataUrlToBytes(imgData);
                    const img = await newDoc.embedJpg(imgBytes);
                    newDoc.addPage([cv.width, cv.height]).drawImage(img, { x: 0, y: 0, width: cv.width, height: cv.height });
                }
                const bytes = await newDoc.save();
                hideLoader();
                await showPDFOutputPreview(bytes, 'compressed.pdf');
            }
        },

        'rotate-pdf': {
            title: 'Rotate PDF',
            desc: 'Rotate all pages in a PDF.',
            icon: '🔄',
            category: 'Organize',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label for="rotation-angle">Rotation angle</label>
                    <select id="rotation-angle">
                        <option value="90">90° clockwise</option>
                        <option value="180">180°</option>
                        <option value="270">90° counter-clockwise</option>
                    </select>
                </div>
            `,
            process: async (options) => {
                showLoader('Rotating PDF pages…');
                const angle = parseInt(options['rotation-angle']);
                const bytes = await selectedFiles[0].arrayBuffer();
                const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                doc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + angle) % 360)));
                const out = await doc.save();
                hideLoader();
                await showPDFOutputPreview(out, 'rotated.pdf');
            }
        },

        'add-page-numbers': {
            title: 'Add Page Numbers',
            desc: 'Stamp page numbers onto every page.',
            icon: '#️⃣',
            category: 'Edit',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label for="page-num-style">Number style</label>
                    <select id="page-num-style">
                        <option value="page-of">Page 1 of 10</option>
                        <option value="of">1 of 10</option>
                        <option value="slash">1 / 10</option>
                        <option value="page-only">Page 1</option>
                        <option value="number-only">1</option>
                        <option value="dashes">— 1 —</option>
                    </select>
                </div>
                <div class="option-group">
                    <label for="page-num-position">Position on page</label>
                    <select id="page-num-position">
                        <option value="bottom-center">Bottom center</option>
                        <option value="bottom-left">Bottom left</option>
                        <option value="bottom-right">Bottom right</option>
                        <option value="top-center">Top center</option>
                        <option value="top-left">Top left</option>
                        <option value="top-right">Top right</option>
                    </select>
                </div>
                <p id="page-num-example" style="font-size:.82rem;color:var(--muted);margin-top:-4px"></p>
            `,
            init: (optEl) => {
                const styleSel = optEl.querySelector('#page-num-style');
                const example = optEl.querySelector('#page-num-example');
                const render = () => {
                    if (!document.body.contains(example)) {
                        document.removeEventListener('input-pdf-loaded', render);
                        return;
                    }
                    const total = (previewPDFDoc && previewPDFDoc.numPages) || 10;
                    const fmt = PAGE_NUM_STYLES[styleSel.value];
                    const shown = fmt.replace('{page}', '1').replace('{total}', total);
                    example.textContent = `Example: “${shown}” on every page`;
                };
                styleSel.addEventListener('change', render);
                document.addEventListener('input-pdf-loaded', render);
                render();
            },
            process: async (options) => {
                showLoader('Adding page numbers to PDF…');
                const format = PAGE_NUM_STYLES[options['page-num-style']] || PAGE_NUM_STYLES['page-of'];
                const bytes = await selectedFiles[0].arrayBuffer();
                const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                const font = await doc.embedFont(StandardFonts.Helvetica);
                const pages = doc.getPages();
                const total = pages.length;
                pages.forEach((page, i) => {
                    const { width, height } = page.getSize();
                    const text = format.replace('{page}', i + 1).replace('{total}', total);
                    const sz = 12, tw = font.widthOfTextAtSize(text, sz);
                    const pos = options['page-num-position'];
                    const m = 30;
                    let x = pos.includes('left') ? m : pos.includes('right') ? width - tw - m : width / 2 - tw / 2;
                    let y = pos.includes('top') ? height - m - sz : m;
                    page.drawText(text, { x, y, size: sz, font, color: rgb(0, 0, 0) });
                });
                const out = await doc.save();
                hideLoader();
                await showPDFOutputPreview(out, 'numbered.pdf');
            }
        },

        'watermark-pdf': {
            title: 'Watermark PDF',
            desc: 'Stamp diagonal text watermark on every page.',
            icon: '💧',
            category: 'Edit',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label for="watermark-text">Watermark text</label>
                    <input type="text" id="watermark-text" value="CONFIDENTIAL">
                </div>
                <div class="option-group">
                    <label for="watermark-size">Font size</label>
                    <input type="number" id="watermark-size" value="72">
                </div>
                <div class="option-group">
                    <label>Opacity</label>
                    <div class="range-row">
                        <input type="range" id="watermark-opacity" min="0" max="1" step="0.1" value="0.3">
                        <span class="range-val" id="watermark-opacity-val">0.3</span>
                    </div>
                </div>
            `,
            process: async (options) => {
                showLoader('Adding watermark to PDF…');
                const text = options['watermark-text'];
                const fontSize = parseInt(options['watermark-size']);
                const opacity = parseFloat(options['watermark-opacity']);
                const bytes = await selectedFiles[0].arrayBuffer();
                const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                const font = await doc.embedFont(StandardFonts.HelveticaBold);
                doc.getPages().forEach(page => {
                    const { width, height } = page.getSize();
                    const tw = font.widthOfTextAtSize(text, fontSize);
                    const th = font.heightAtSize(fontSize);
                    page.drawText(text, {
                        x: width / 2 - tw / 2, y: height / 2 - th / 2,
                        font, size: fontSize, color: rgb(0.5, 0.5, 0.5),
                        opacity, rotate: degrees(45)
                    });
                });
                const out = await doc.save();
                hideLoader();
                await showPDFOutputPreview(out, 'watermarked.pdf');
            }
        },

        'jpg-to-pdf': {
            title: 'JPG to PDF',
            desc: 'Convert one or more JPG images to PDF.',
            icon: '🖼️',
            category: 'Convert',
            fileType: '.jpg,.jpeg',
            multiple: true,
            process: async () => {
                showLoader('Converting JPG images to PDF…');
                const doc = await PDFDocument.create();
                for (const f of selectedFiles) {
                    const img = await doc.embedJpg(await f.arrayBuffer());
                    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
                }
                const bytes = await doc.save();
                hideLoader();
                await showPDFOutputPreview(bytes, 'converted.pdf');
            }
        },

        'png-to-pdf': {
            title: 'PNG to PDF',
            desc: 'Convert PNG images to a PDF document.',
            icon: '🖼️',
            category: 'Convert',
            fileType: '.png',
            multiple: true,
            process: async () => {
                showLoader('Converting PNG images to PDF…');
                const doc = await PDFDocument.create();
                for (const f of selectedFiles) {
                    const img = await doc.embedPng(await f.arrayBuffer());
                    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
                }
                const bytes = await doc.save();
                hideLoader();
                await showPDFOutputPreview(bytes, 'converted.pdf');
            }
        },

        'pdf-to-jpg': {
            title: 'PDF to JPG',
            desc: 'Render every page as a JPG image.',
            icon: '📄',
            category: 'Convert',
            fileType: '.pdf',
            multiple: false,
            process: async () => {
                showLoader('Converting PDF pages to JPG…');
                const bytes = await selectedFiles[0].arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                const zip = new JSZip();
                for (let i = 1; i <= pdf.numPages; i++) {
                    showLoader(`Converting page ${i}/${pdf.numPages}…`);
                    const pg = await pdf.getPage(i);
                    const vp = pg.getViewport({ scale: 2 });
                    const cv = document.createElement('canvas');
                    cv.width = vp.width; cv.height = vp.height;
                    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
                    zip.file(`page_${i}.jpg`, cv.toDataURL('image/jpeg').split(',')[1], { base64: true });
                }
                createDownloadLink(await zip.generateAsync({ type: 'blob' }), 'pages.zip', 'application/zip');
            }
        },

        'pdf-to-word': {
            title: 'PDF to Word',
            desc: 'Convert a PDF to Word. Auto-handles native-text and scanned PDFs.',
            icon: '📝',
            category: 'Convert',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label for="pdf-word-mode">Conversion engine</label>
                    <select id="pdf-word-mode">
                        <option value="server">Server auto — layout-aware for native text, OCR for scanned</option>
                        <option value="text">In-browser text (paragraphs, headings, bold/italic)</option>
                        <option value="image">In-browser page images (visual only, not editable)</option>
                    </select>
                </div>
                <div class="option-group">
                    <label for="pdf-word-ocr-lang">Document language <span style="color:var(--muted);font-weight:400">(used only if the PDF is scanned)</span></label>
                    <select id="pdf-word-ocr-lang">
                        <option value="eng">English</option>
                        <option value="spa">Spanish</option>
                        <option value="fra">French</option>
                        <option value="deu">German</option>
                        <option value="ita">Italian</option>
                        <option value="por">Portuguese</option>
                        <option value="nld">Dutch</option>
                        <option value="hin">Hindi</option>
                        <option value="rus">Russian</option>
                        <option value="ara">Arabic</option>
                        <option value="chi_sim">Chinese (Simplified)</option>
                        <option value="jpn">Japanese</option>
                    </select>
                </div>
                <p style="font-size:.78rem;color:var(--muted);margin-top:-4px;line-height:1.5">
                    ⓘ Server mode automatically detects whether the PDF has selectable text or is a
                    scanned image, and picks the right engine (layout-aware conversion or OCR).
                    Only this tool uploads your file (to the OCR/convert backend); all other tools
                    stay 100% in your browser. For tables use <strong>PDF Tables → Excel</strong>.
                </p>
            `,
            process: async (options) => {
                const mode = options['pdf-word-mode'] || 'server';
                const ocrLang = options['pdf-word-ocr-lang'] || 'eng';
                const file = selectedFiles[0];
                const baseName = file.name.replace(/\.pdf$/i, '') || 'converted';
                const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

                let scanned = false;
                if (mode === 'server' && OCR_BACKEND_URL) {
                    try {
                        showLoader('Analysing PDF…');
                        const bytes = await file.arrayBuffer();
                        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                        scanned = await isPdfScanned(pdf);

                        if (scanned) {
                            showLoader('Scanned document — OCR then build DOCX (may take 30s+)…');
                            const pages = await ocrViaBackend(file, ocrLang);
                            const blob = await buildDocxFromOcrPages(pages);
                            hideLoader();
                            createDownloadLink(blob, `${baseName}.docx`, docxType);
                            showToast('✅ Converted scanned document using OCR');
                        } else {
                            showLoader('Converting via server (up to ~30s on cold start)…');
                            const blob = await convertPdfToDocxViaBackend(file);
                            hideLoader();
                            createDownloadLink(blob, `${baseName}.docx`, docxType);
                            showToast('✅ Converted using layout-aware server engine');
                        }
                        return;
                    } catch (err) {
                        console.warn('Backend convert failed — falling back to in-browser text mode:', err);
                        showToast(scanned
                            ? '⚠️ Server unavailable and this looks scanned — the fallback will be near-empty; try "Page images" mode'
                            : '⚠️ Server unavailable — falling back to in-browser text extraction');
                        // fall through to client-side text mode below
                    }
                }

                showLoader('Loading PDF…');
                const bytes = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                const children = mode === 'image'
                    ? await buildImageBasedDocxChildren(pdf)
                    : await buildStructuredDocxChildren(pdf);

                showLoader('Building DOCX…');
                const d = new docx.Document({ sections: [{ children }] });
                const blob = await docx.Packer.toBlob(d);
                hideLoader();
                createDownloadLink(blob, `${baseName}.docx`, docxType);
            }
        },

        'word-to-pdf': {
            title: 'Word to PDF',
            desc: 'Convert DOCX files to PDF format.',
            icon: '📄',
            category: 'Convert',
            fileType: '.docx',
            multiple: false,
            process: async () => {
                showLoader('Converting Word document to PDF…');
                const result = await mammoth.convertToHtml({ arrayBuffer: await selectedFiles[0].arrayBuffer() });
                const el = document.createElement('div');
                el.style.cssText = 'position:fixed;left:-99999px;top:0;width:794px;padding:40px;background:#fff;color:#000;font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.45';
                const style = document.createElement('style');
                style.textContent = `
                    h1{font-size:26px;margin:0 0 12px;font-weight:700}
                    h2{font-size:22px;margin:18px 0 10px;font-weight:700}
                    h3{font-size:18px;margin:14px 0 8px;font-weight:700}
                    h4{font-size:16px;margin:12px 0 6px;font-weight:700}
                    p{margin:0 0 10px}
                    table{border-collapse:collapse;width:100%;margin:10px 0}
                    td,th{border:1px solid #999;padding:6px 8px;vertical-align:top}
                    th{background:#f2f2f2;font-weight:700}
                    img{max-width:100%;height:auto}
                    ul,ol{margin:0 0 10px 24px;padding:0}
                `;
                el.appendChild(style);
                const body = document.createElement('div');
                body.innerHTML = sanitizeHtml(result.value || '<p>(empty document)</p>');
                el.appendChild(body);
                document.body.appendChild(el);
                try {
                    const blob = await html2pdf().from(el).set({
                        margin: [10, 10, 10, 10],
                        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                        pagebreak: { mode: ['css', 'legacy'] }
                    }).output('blob');
                    hideLoader();
                    await showPDFOutputPreview(blob, 'converted.pdf');
                } finally {
                    document.body.removeChild(el);
                }
            }
        },

        'excel-to-pdf': {
            title: 'Excel to PDF',
            desc: 'Convert XLSX spreadsheets to PDF.',
            icon: '📊',
            category: 'Convert',
            fileType: '.xlsx',
            multiple: false,
            process: async () => {
                showLoader('Converting Excel sheet to PDF…');
                const wb = XLSX.read(await selectedFiles[0].arrayBuffer(), { type: 'buffer' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const el = document.createElement('div');
                el.style.cssText = 'position:fixed;left:-99999px;top:0;width:1100px;padding:20px;background:#fff;color:#000';
                const style = document.createElement('style');
                style.textContent = `table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:10px}th,td{border:1px solid #ddd;text-align:left;padding:4px}th{background:#f2f2f2;font-weight:bold}`;
                el.appendChild(style);
                const body = document.createElement('div');
                body.innerHTML = sanitizeHtml(XLSX.utils.sheet_to_html(ws));
                el.appendChild(body);
                document.body.appendChild(el);
                try {
                    const blob = await html2pdf().from(el).set({
                        margin: 10,
                        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
                        pagebreak: { mode: ['css', 'legacy'] }
                    }).output('blob');
                    hideLoader();
                    await showPDFOutputPreview(blob, 'from_excel.pdf');
                } finally {
                    document.body.removeChild(el);
                }
            }
        },
    };

    // ── TABLE DETECTION ENGINE ────────────────────────────────────────────
    function extractTablesFromTextContent(content, sensitivity) {
        const items = content.items.map(it => ({
            text: it.str,
            x: Math.round(it.transform[4]),
            y: Math.round(it.transform[5]),
            w: it.width
        })).filter(it => it.text.trim() !== '');

        if (items.length === 0) return [];

        const yTolerance = Math.max(4, 9 - sensitivity);
        const rows = [];
        const used = new Set();
        const sortedY = [...new Set(items.map(it => it.y))].sort((a, b) => b - a);

        sortedY.forEach(y => {
            if (used.has(y)) return;
            const row = items.filter(it => Math.abs(it.y - y) <= yTolerance && !used.has(it.y));
            row.forEach(it => used.add(it.y));
            if (row.length >= 2) rows.push(row.sort((a, b) => a.x - b.x));
        });

        if (rows.length < 2) return [];

        const minCols = Math.max(2, 4 - sensitivity);
        const tables = [];
        let tableRows = [];

        rows.forEach((row) => {
            if (row.length >= minCols) {
                tableRows.push(row.map(it => it.text.trim()));
            } else {
                if (tableRows.length >= 2) tables.push(normalizeTable(tableRows));
                tableRows = [];
            }
        });
        if (tableRows.length >= 2) tables.push(normalizeTable(tableRows));

        return tables;
    }

    // ── PDF → DOCX STRUCTURE DETECTION ───────────────────────────────────
    // Turn a PDF page's positioned text fragments into real lines and
    // paragraphs by clustering on Y coordinate and vertical gap. Detects
    // bold/italic from font names and headings from font-size jumps off
    // the document's baseline. This is heuristic — complex layouts (multi-
    // column, tables, footnotes) won't survive — but it's much closer than
    // joining every fragment with a space.
    function groupItemsIntoLines(items) {
        const lines = [];
        const sorted = [...items]
            .filter(it => (it.str || '').length > 0)
            .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);

        for (const item of sorted) {
            const y = item.transform[5];
            const x = item.transform[4];
            const fontSize = Math.abs(item.transform[3]) || item.height || 12;
            const tol = Math.max(2, fontSize * 0.3);
            let line = lines[lines.length - 1];
            if (!line || Math.abs(line.y - y) > tol) {
                line = { y, items: [], maxSize: 0 };
                lines.push(line);
            }
            line.items.push({ text: item.str, x, fontName: item.fontName || '', fontSize });
            line.maxSize = Math.max(line.maxSize, fontSize);
        }

        return lines.map(line => {
            line.items.sort((a, b) => a.x - b.x);
            const text = line.items.map(it => it.text).join('').replace(/\s+/g, ' ').trim();
            return {
                y: line.y,
                text,
                fontSize: line.maxSize,
                fontName: line.items[0] ? line.items[0].fontName : ''
            };
        }).filter(l => l.text.length > 0);
    }

    function detectBaseFontSize(lines) {
        if (!lines.length) return 12;
        const freq = new Map();
        for (const l of lines) {
            const k = Math.round(l.fontSize);
            freq.set(k, (freq.get(k) || 0) + l.text.length);
        }
        return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    function groupLinesIntoParagraphs(lines) {
        if (!lines.length) return [];
        const paragraphs = [{ lines: [lines[0]] }];
        for (let i = 1; i < lines.length; i++) {
            const prev = lines[i - 1];
            const curr = lines[i];
            const gap = Math.abs(prev.y - curr.y);
            const lineHeight = Math.max(prev.fontSize, curr.fontSize);
            const sizeShift = Math.abs(prev.fontSize - curr.fontSize) > prev.fontSize * 0.2;
            if (gap > lineHeight * 1.6 || sizeShift) {
                paragraphs.push({ lines: [curr] });
            } else {
                paragraphs[paragraphs.length - 1].lines.push(curr);
            }
        }
        return paragraphs;
    }

    async function buildStructuredDocxChildren(pdf) {
        const { Paragraph, TextRun, HeadingLevel, PageBreak } = docx;
        const children = [];

        // First pass: collect all lines across all pages to compute a global
        // baseline font size — otherwise heading detection drifts page-by-page.
        const perPageLines = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            showLoader(`Reading page ${i}/${pdf.numPages}…`);
            const pg = await pdf.getPage(i);
            const content = await pg.getTextContent();
            perPageLines.push(groupItemsIntoLines(content.items));
        }
        const baseSize = detectBaseFontSize(perPageLines.flat());

        for (let i = 0; i < perPageLines.length; i++) {
            const lines = perPageLines[i];
            const paragraphs = groupLinesIntoParagraphs(lines);

            for (const para of paragraphs) {
                const text = para.lines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                const size = para.lines[0].fontSize;
                const font = para.lines[0].fontName;
                const isBold = /bold|black|heavy/i.test(font);
                const isItalic = /italic|oblique/i.test(font);

                let heading;
                if (size >= baseSize * 1.8) heading = HeadingLevel.HEADING_1;
                else if (size >= baseSize * 1.4) heading = HeadingLevel.HEADING_2;
                else if (size >= baseSize * 1.2) heading = HeadingLevel.HEADING_3;

                // half-points; cap at sensible bounds
                const sizeHP = Math.max(12, Math.min(144, Math.round(size * 2)));

                children.push(new Paragraph({
                    heading,
                    children: [new TextRun({
                        text,
                        bold: isBold || !!heading,
                        italics: isItalic,
                        size: sizeHP
                    })],
                    spacing: { after: 120 }
                }));
            }

            if (i < perPageLines.length - 1) {
                children.push(new Paragraph({ children: [new PageBreak()] }));
            }
        }
        return children;
    }

    // Returns per-page pseudo-textContent objects with items shaped like
    // pdf.js's own (each has a transform matrix where [4]=x, [5]=y) so the
    // existing table detector runs unchanged. Y is flipped from image-pixel
    // space (top=0) into "higher = further up on page" so items sort the
    // same way as native PDF text.
    //
    // Prefers the backend (native Tesseract on Render, higher accuracy) and
    // falls back to in-browser Tesseract.js if the server is unreachable.
    async function ocrPagesToPositionedItems(file, pdf, lang) {
        if (OCR_BACKEND_URL) {
            try {
                showLoader('Sending to OCR server (native Tesseract with positions)…');
                const pages = await ocrWordsViaBackend(file, lang);
                return pages.map(page => {
                    const pageH = page.height || 0;
                    const items = (page.words || []).map(w => {
                        const h = w.h || 12;
                        return {
                            str: w.str,
                            width: w.w,
                            height: h,
                            transform: [1, 0, 0, h, w.x, pageH - w.y]
                        };
                    });
                    return { items };
                });
            } catch (err) {
                console.warn('Backend positional OCR failed — falling back to in-browser:', err);
                showToast('⚠️ OCR server unavailable — using in-browser OCR (slower, less accurate)');
            }
        }

        if (typeof Tesseract === 'undefined') {
            throw new Error('Tesseract.js not loaded (blocked by CSP?)');
        }
        showLoader('Loading OCR engine…');
        const worker = await Tesseract.createWorker(lang, 1, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    showLoader(`OCR recognizing text… ${Math.round((m.progress || 0) * 100)}%`);
                }
            }
        });
        const perPage = [];
        try {
            for (let i = 1; i <= pdf.numPages; i++) {
                showLoader(`OCR page ${i} of ${pdf.numPages}…`);
                const pg = await pdf.getPage(i);
                const vp = pg.getViewport({ scale: 2 });
                const cv = document.createElement('canvas');
                cv.width = vp.width; cv.height = vp.height;
                await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
                const { data } = await worker.recognize(cv);
                const words = data.words || [];
                const items = words
                    .filter(w => w.text && w.text.trim())
                    .map(w => {
                        const x = w.bbox.x0;
                        const yFromTop = w.bbox.y0;
                        const width = w.bbox.x1 - w.bbox.x0;
                        const height = (w.bbox.y1 - w.bbox.y0) || 12;
                        return {
                            str: w.text,
                            width,
                            height,
                            transform: [1, 0, 0, height, x, vp.height - yFromTop]
                        };
                    });
                perPage.push({ items });
            }
        } finally {
            await worker.terminate();
        }
        return perPage;
    }

    // Heuristic: sample the first few pages and decide the PDF is "scanned"
    // (image-only, no selectable text) if the average character count per page
    // is below a small threshold. Real text PDFs usually have hundreds of
    // characters per page even on a mostly-blank page.
    async function isPdfScanned(pdf) {
        const pagesToCheck = Math.min(3, pdf.numPages);
        let totalChars = 0;
        for (let i = 1; i <= pagesToCheck; i++) {
            const pg = await pdf.getPage(i);
            const content = await pg.getTextContent();
            totalChars += content.items.reduce((sum, it) => sum + (it.str || '').length, 0);
        }
        return totalChars / pagesToCheck < 50;
    }

    // Build a DOCX from an array of per-page OCR text (as returned by /ocr).
    // Splits each page on blank lines to make rough paragraphs, and inserts a
    // page break between OCR'd pages so pagination matches the source.
    async function buildDocxFromOcrPages(pageTexts) {
        const { Paragraph, TextRun, PageBreak } = docx;
        const children = [];
        pageTexts.forEach((pageText, i) => {
            const paragraphs = (pageText || '').split(/\n\s*\n/);
            for (const p of paragraphs) {
                const text = p.replace(/\s+/g, ' ').trim();
                if (text) {
                    children.push(new Paragraph({
                        children: [new TextRun({ text })],
                        spacing: { after: 120 }
                    }));
                }
            }
            if (i < pageTexts.length - 1) {
                children.push(new Paragraph({ children: [new PageBreak()] }));
            }
        });
        const d = new docx.Document({ sections: [{ children }] });
        return await docx.Packer.toBlob(d);
    }

    async function buildImageBasedDocxChildren(pdf) {
        const { Paragraph, ImageRun, PageBreak } = docx;
        const children = [];
        const maxWidthPx = 600;

        for (let i = 1; i <= pdf.numPages; i++) {
            showLoader(`Rendering page ${i}/${pdf.numPages}…`);
            const pg = await pdf.getPage(i);
            const vp = pg.getViewport({ scale: 1.5 });
            const cv = document.createElement('canvas');
            cv.width = vp.width; cv.height = vp.height;
            await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            const dataUrl = cv.toDataURL('image/jpeg', 0.78);
            const imgBytes = dataUrlToBytes(dataUrl);
            const ratio = vp.height / vp.width;

            children.push(new Paragraph({
                children: [new ImageRun({
                    data: imgBytes,
                    transformation: { width: maxWidthPx, height: Math.round(maxWidthPx * ratio) }
                })]
            }));
            if (i < pdf.numPages) {
                children.push(new Paragraph({ children: [new PageBreak()] }));
            }
        }
        return children;
    }

    function normalizeTable(rows) {
        const maxCols = Math.max(...rows.map(r => r.length));
        return rows.map(r => {
            while (r.length < maxCols) r.push('');
            return r;
        });
    }

    // ── TABLE PREVIEW ─────────────────────────────────────────────────────
    function renderTablePreview(allTables, useHeader, blob, origFilename) {
        let activeTbl = 0;

        function buildHTML() {
            const pills = allTables.map((t, i) =>
                `<button class="tbl-pill${i === activeTbl ? ' active' : ''}" data-i="${i}">
                    Pg ${t.pageNum} · T${t.tableIndex} (${t.rows.length} rows)
                </button>`
            ).join('');

            const tbl = allTables[activeTbl];
            const rows = tbl.rows.filter(r => r.some(c => c && c.trim()));
            const header = useHeader && rows.length > 0 ? rows[0] : null;
            const body = useHeader ? rows.slice(1) : rows;

            const thead = header
                ? `<thead><tr>${header.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr></thead>`
                : '';
            const tbody = `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;

            return `
                <div style="margin-top:20px">
                    <div style="font-size:.82rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:0;margin-bottom:10px">
                        ✅ ${allTables.length} table${allTables.length > 1 ? 's' : ''} found
                    </div>
                    <div class="table-nav" id="tbl-nav">${pills}</div>
                    <div class="preview-wrap">
                        <div class="preview-label">
                            <span>Preview — Page ${tbl.pageNum}, Table ${tbl.tableIndex}</span>
                            <span>${rows.length} rows × ${rows[0] ? rows[0].length : 0} cols</span>
                        </div>
                        <div class="preview-scroll">
                            <table>${thead}${tbody}</table>
                        </div>
                    </div>
                    <a href="#" class="dl-btn" id="dl-excel-btn" style="margin-top:14px">
                        ⬇ Download Excel (.xlsx) · All ${allTables.length} sheet${allTables.length > 1 ? 's' : ''}
                    </a>
                </div>
            `;
        }

        const out = document.getElementById('output-area');
        const refresh = () => {
            out.innerHTML = sanitizeHtml(buildHTML());
            const url = URL.createObjectURL(blob);
            const baseName = origFilename.replace(/\.pdf$/i, '');
            out.querySelector('#dl-excel-btn').href = url;
            out.querySelector('#dl-excel-btn').download = `${baseName}_tables.xlsx`;
            out.querySelectorAll('.tbl-pill').forEach(btn => {
                btn.addEventListener('click', () => {
                    activeTbl = parseInt(btn.dataset.i);
                    refresh();
                });
            });
        };
        refresh();
    }

    // ── OCR BACKEND (native Tesseract) ────────────────────────────────────
    async function ocrViaBackend(file, lang) {
        const base = OCR_BACKEND_URL.replace(/\/+$/, '');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('lang', lang);
        const res = await fetch(base + '/ocr', { method: 'POST', body: fd });
        if (!res.ok) {
            let msg = `OCR server responded ${res.status}`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
            throw new Error(msg);
        }
        const data = await res.json();
        if (Array.isArray(data.pages) && data.pages.length) {
            return data.pages.map(t => (t || '').trim());
        }
        return [String(data.text || '').trim()];
    }

    // Positional OCR via the backend — returns per-page word bboxes from
    // Tesseract's TSV output. Way more accurate than in-browser Tesseract.js.
    async function ocrWordsViaBackend(file, lang) {
        const base = OCR_BACKEND_URL.replace(/\/+$/, '');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('lang', lang);
        fd.append('format', 'words');
        const res = await fetch(base + '/ocr', { method: 'POST', body: fd });
        if (!res.ok) {
            let msg = `OCR server responded ${res.status}`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
            throw new Error(msg);
        }
        const data = await res.json();
        return Array.isArray(data.pages) ? data.pages : [];
    }

    // ── PDF→DOCX BACKEND (layout-aware pdf2docx) ──────────────────────────
    async function convertPdfToDocxViaBackend(file) {
        const base = OCR_BACKEND_URL.replace(/\/+$/, '');
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(base + '/pdf-to-docx', { method: 'POST', body: fd });
        if (!res.ok) {
            let msg = `Convert server responded ${res.status}`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* body may be binary/HTML */ }
            throw new Error(msg);
        }
        return await res.blob();
    }

    // ── OCR RESULT ────────────────────────────────────────────────────────
    function renderOcrResult(pageTexts, plainText, txtBlob, docxBlob, origFilename, engine) {
        const baseName = origFilename.replace(/\.(pdf|png|jpe?g)$/i, '');
        const isNative = engine === 'native';
        const engineBadge = isNative
            ? `<span style="font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:999px;background:#dcfce7;color:#166534;white-space:nowrap">🖥️ Native Tesseract (server)</span>`
            : `<span style="font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:999px;background:#dbeafe;color:#1e40af;white-space:nowrap">🌐 In-browser Tesseract.js</span>`;
        const out = document.getElementById('output-area');
        out.innerHTML = sanitizeHtml(`
            <div style="margin-top:20px">
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
                    <span style="font-size:.82rem;font-weight:700;color:var(--red);text-transform:uppercase">
                        ✅ OCR complete · ${pageTexts.length} page${pageTexts.length > 1 ? 's' : ''} · ${plainText.length} characters
                    </span>
                    ${engineBadge}
                </div>
                <div class="preview-wrap">
                    <div class="preview-label">
                        <span>Extracted text</span>
                        <span>${pageTexts.length} page${pageTexts.length > 1 ? 's' : ''}</span>
                    </div>
                    <textarea id="ocr-text-area" readonly
                        style="width:100%;min-height:240px;border:none;outline:none;resize:vertical;padding:14px;font-family:'DM Sans',monospace;font-size:.86rem;line-height:1.5;background:transparent;color:inherit;box-sizing:border-box">${escHtml(plainText)}</textarea>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
                    <button class="dl-btn" id="ocr-copy-btn" type="button" style="cursor:pointer;border:none">📋 Copy text</button>
                    <a href="#" class="dl-btn" id="ocr-txt-btn">⬇ Download .txt</a>
                    <a href="#" class="dl-btn" id="ocr-docx-btn">⬇ Download .docx</a>
                </div>
            </div>
        `);

        const txtBtn = out.querySelector('#ocr-txt-btn');
        txtBtn.href = URL.createObjectURL(txtBlob);
        txtBtn.download = `${baseName}_ocr.txt`;

        const docxBtn = out.querySelector('#ocr-docx-btn');
        docxBtn.href = URL.createObjectURL(docxBlob);
        docxBtn.download = `${baseName}_ocr.docx`;

        const copyBtn = out.querySelector('#ocr-copy-btn');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(plainText);
                showToast('✅ Text copied to clipboard');
            } catch {
                const ta = out.querySelector('#ocr-text-area');
                ta.removeAttribute('readonly'); ta.select();
                document.execCommand('copy');
                ta.setAttribute('readonly', '');
                showToast('✅ Text copied to clipboard');
            }
        });
    }

    function escHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function sanitizeHtml(html) {
        return window.DOMPurify ? DOMPurify.sanitize(html) : escHtml(html);
    }

    function dataUrlToBytes(dataUrl) {
        const base64 = dataUrl.split(',')[1] || '';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // ── PDF PREVIEW ENGINE ────────────────────────────────────────────────
    async function loadPDFIntoPreview(arrayBuffer, label) {
        const panel = document.getElementById('pdf-preview-panel');
        panel.style.display = 'block';
        document.getElementById('preview-loading').style.display = 'flex';
        document.getElementById('pdf-preview-canvas').style.display = 'none';
        document.getElementById('preview-thumb-strip').innerHTML = '';
        document.getElementById('preview-panel-label').textContent = label;

        previewPDFDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const total = previewPDFDoc.numPages;

        document.getElementById('preview-total-pages').textContent = total;
        document.getElementById('total-page-num').textContent = total;
        document.getElementById('prev-page-btn').disabled = true;
        document.getElementById('next-page-btn').disabled = total <= 1;

        previewCurrentPage = 1;
        await renderPreviewPage(1);
        await buildThumbStrip(total);
    }

    async function initPDFPreview(file) {
        await loadPDFIntoPreview(await file.arrayBuffer(), 'Input preview');
        document.dispatchEvent(new CustomEvent('input-pdf-loaded'));
    }

    function clearOutputPreviewActions() {
        document.querySelectorAll('.output-preview-actions').forEach(n => n.remove());
    }

    // Switch the preview panel from the input PDF to the produced output PDF,
    // then render a Download button directly below the panel. Use whenever a
    // tool produces a PDF so the user can flip through pages and verify before
    // saving — and the Download CTA is right there, not buried below the
    // unchanged tool-options block.
    async function showPDFOutputPreview(data, filename) {
        const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/pdf' });
        const bytes = new Uint8Array(await blob.arrayBuffer());

        document.getElementById('output-area').innerHTML = '';
        clearOutputPreviewActions();

        try {
            // pdf.js takes ownership of the buffer it's given (it may detach it),
            // so pass a fresh copy and keep the Blob intact for the download link.
            await loadPDFIntoPreview(bytes.slice().buffer, 'Output preview');
        } catch (err) {
            console.warn('Output preview render failed; download link still shown:', err);
        }

        const actions = document.createElement('div');
        actions.className = 'output-preview-actions';
        const link = document.createElement('a');
        link.className = 'dl-btn';
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.textContent = `⬇ Download ${filename}`;
        actions.appendChild(link);

        const panel = document.getElementById('pdf-preview-panel');
        panel.insertAdjacentElement('afterend', actions);
        actions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function renderPreviewPage(pageNum) {
        if (previewRendering) { previewPendingPage = pageNum; return; }
        previewRendering = true;

        document.getElementById('preview-loading').style.display = 'flex';
        document.getElementById('pdf-preview-canvas').style.display = 'none';

        const page = await previewPDFDoc.getPage(pageNum);
        const container = document.querySelector('.preview-canvas-wrap');
        const maxW = container.clientWidth - 32 || 640;
        const baseVP = page.getViewport({ scale: 1 });
        const scale = Math.min(2, maxW / baseVP.width);
        const viewport = page.getViewport({ scale });

        const canvas = document.getElementById('pdf-preview-canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport }).promise;

        document.getElementById('preview-loading').style.display = 'none';
        canvas.style.display = 'block';
        document.getElementById('cur-page-num').textContent = pageNum;
        document.getElementById('prev-page-btn').disabled = pageNum <= 1;
        document.getElementById('next-page-btn').disabled = pageNum >= previewPDFDoc.numPages;

        document.querySelectorAll('.preview-thumb').forEach(t =>
            t.classList.toggle('active', parseInt(t.dataset.page) === pageNum)
        );

        previewRendering = false;
        if (previewPendingPage !== null) {
            const next = previewPendingPage;
            previewPendingPage = null;
            await renderPreviewPage(next);
        }
    }

    async function buildThumbStrip(total) {
        const strip = document.getElementById('preview-thumb-strip');
        strip.innerHTML = '';
        const MAX_THUMBS = Math.min(total, 20);
        for (let i = 1; i <= MAX_THUMBS; i++) {
            const page = await previewPDFDoc.getPage(i);
            const vp = page.getViewport({ scale: 0.18 });
            const cv = document.createElement('canvas');
            cv.width = vp.width; cv.height = vp.height;
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

            const thumb = document.createElement('div');
            thumb.className = 'preview-thumb' + (i === 1 ? ' active' : '');
            thumb.dataset.page = i;
            thumb.appendChild(cv);
            const lbl = document.createElement('div');
            lbl.className = 'pg-num'; lbl.textContent = i;
            thumb.appendChild(lbl);
            thumb.addEventListener('click', () => {
                previewCurrentPage = i;
                renderPreviewPage(i);
            });
            strip.appendChild(thumb);
        }
        if (total > MAX_THUMBS) {
            const more = document.createElement('div');
            more.style.cssText = 'flex-shrink:0;display:flex;align-items:center;padding:0 8px;font-size:.75rem;color:var(--muted);white-space:nowrap';
            more.textContent = `+${total - MAX_THUMBS} more`;
            strip.appendChild(more);
        }
    }

    function clearPDFPreview() {
        previewPDFDoc = null;
        previewCurrentPage = 1;
        previewRendering = false;
        previewPendingPage = null;
        const panel = document.getElementById('pdf-preview-panel');
        panel.style.display = 'none';
        document.getElementById('preview-thumb-strip').innerHTML = '';
        const canvas = document.getElementById('pdf-preview-canvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    document.getElementById('prev-page-btn').addEventListener('click', () => {
        if (previewCurrentPage > 1) { previewCurrentPage--; renderPreviewPage(previewCurrentPage); }
    });
    document.getElementById('next-page-btn').addEventListener('click', () => {
        if (previewPDFDoc && previewCurrentPage < previewPDFDoc.numPages) {
            previewCurrentPage++;
            renderPreviewPage(previewCurrentPage);
        }
    });

    // ── CATEGORIES ────────────────────────────────────────────────────────
    const categories = ['All', ...new Set(Object.values(toolImplementations).map(t => t.category))];
    let activeCategory = 'All';
    document.getElementById('tool-count').textContent = `${Object.keys(toolImplementations).length} free tools`;

    const catPillsEl = document.getElementById('cat-pills');
    categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'cat-pill' + (cat === 'All' ? ' active' : '');
        btn.textContent = cat;
        btn.addEventListener('click', () => {
            activeCategory = cat;
            catPillsEl.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderGrid();
        });
        catPillsEl.appendChild(btn);
    });

    function renderGrid() {
        const grid = document.getElementById('tools-grid');
        grid.innerHTML = '';
        Object.entries(toolImplementations).forEach(([id, tool]) => {
            if (activeCategory !== 'All' && tool.category !== activeCategory) return;
            const card = document.createElement('div');
            card.className = 'tool-card';
            card.dataset.toolId = id;
            const badge = tool.badge === 'new'
                ? '<span class="badge-new">New</span>'
                : tool.badge === 'hot' ? '<span class="badge-hot">🔥</span>' : '';
            card.innerHTML = sanitizeHtml(`${badge}<div class="t-icon">${escHtml(tool.icon)}</div><h3>${escHtml(tool.title)}</h3><p>${escHtml(tool.desc)}</p>`);
            card.addEventListener('click', () => openModal(id));
            grid.appendChild(card);
        });
    }
    renderGrid();

    // ── MODAL / EVENT HANDLERS ────────────────────────────────────────────
    const modal = document.getElementById('tool-modal');
    const fileInput = document.getElementById('file-input');

    document.getElementById('close-modal').addEventListener('click', closeModal);
    document.getElementById('browse-file-btn').addEventListener('click', () => fileInput.click());
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display === 'block') closeModal();
    });

    const dropZone = document.getElementById('drop-zone');
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', e => { e.preventDefault(); dropZone.classList.remove('dragover'); });
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', e => handleFiles(e.target.files));

    document.getElementById('process-btn').addEventListener('click', async () => {
        const tool = toolImplementations[currentToolId];
        if (!tool) return;
        try {
            const opts = {};
            document.getElementById('tool-options').querySelectorAll('input,select,textarea').forEach(inp => {
                opts[inp.id] = inp.type === 'checkbox' ? inp.checked : inp.value;
            });
            await tool.process(opts);
        } catch (err) {
            console.error(err);
            showToast('⚠️ ' + err.message);
        } finally {
            hideLoader();
        }
    });

    function openModal(toolId) {
        resetModal();
        currentToolId = toolId;
        const tool = toolImplementations[toolId];
        document.getElementById('modal-title').textContent = tool.title;
        document.getElementById('modal-icon').textContent = tool.icon;
        fileInput.accept = tool.fileType || '';
        fileInput.multiple = tool.multiple || false;
        const optEl = document.getElementById('tool-options');
        if (tool.options) {
            optEl.innerHTML = sanitizeHtml(tool.options());
            optEl.querySelectorAll('input[type=range]').forEach(slider => {
                const valSpan = document.getElementById(slider.id + '-val');
                if (valSpan) { valSpan.textContent = slider.value; slider.oninput = () => valSpan.textContent = slider.value; }
            });
            if (tool.init) tool.init(optEl);
        }
        modal.style.display = 'block';
    }

    function closeModal() { modal.style.display = 'none'; resetModal(); }

    function resetModal() {
        selectedFiles = []; updateFileList();
        document.getElementById('tool-options').innerHTML = '';
        document.getElementById('output-area').innerHTML = '';
        clearOutputPreviewActions();
        document.getElementById('process-btn').disabled = true;
        fileInput.value = '';
        currentToolId = null;
        clearPDFPreview();
    }

    function handleFiles(files) {
        const tool = toolImplementations[currentToolId];
        if (!tool) return;
        const arr = Array.from(files);
        const oversized = arr.filter(f => f.size > MAX_FILE_SIZE_BYTES);
        if (oversized.length > 0) {
            showToast(`File too large. Max size is ${MAX_FILE_SIZE_MB}MB.`);
            fileInput.value = '';
            return;
        }
        clearOutputPreviewActions();
        document.getElementById('output-area').innerHTML = '';
        if (tool.fileType) {
            const allowed = tool.fileType.split(',').map(e => e.trim().toLowerCase());
            const valid = arr.filter(f => allowed.includes('.' + f.name.split('.').pop().toLowerCase()));
            if (valid.length !== arr.length) { showToast(`Please select only ${tool.fileType} files`); return; }
            selectedFiles = tool.multiple ? [...selectedFiles, ...valid] : [valid[0]];
        } else {
            selectedFiles = tool.multiple ? [...selectedFiles, ...arr] : [arr[0]];
        }
        updateFileList();
        if (selectedFiles.length) {
            document.getElementById('process-btn').disabled = false;
            const pdfFile = selectedFiles.find(f => f.name.toLowerCase().endsWith('.pdf'));
            if (pdfFile) {
                initPDFPreview(pdfFile).catch(err => {
                    console.warn('Preview failed:', err);
                    clearPDFPreview();
                });
            } else {
                clearPDFPreview();
            }
        }
    }

    function updateFileList() {
        const el = document.getElementById('file-list');
        el.innerHTML = '';
        const tool = toolImplementations[currentToolId];
        const reorderable = !!(tool && tool.multiple && selectedFiles.length > 1);

        selectedFiles.forEach((f, i) => {
            const item = document.createElement('div');
            item.className = 'file-item';

            if (reorderable) {
                const ord = document.createElement('span');
                ord.className = 'file-item-ord';
                ord.textContent = i + 1;
                item.appendChild(ord);
            }

            const name = document.createElement('span');
            name.className = 'file-item-name';
            name.textContent = `File: ${f.name}`;
            item.appendChild(name);

            if (reorderable) {
                const up = document.createElement('button');
                up.className = 'file-reorder-btn';
                up.dataset.action = 'up';
                up.dataset.i = i;
                up.disabled = i === 0;
                up.title = 'Move up';
                up.textContent = '↑';

                const down = document.createElement('button');
                down.className = 'file-reorder-btn';
                down.dataset.action = 'down';
                down.dataset.i = i;
                down.disabled = i === selectedFiles.length - 1;
                down.title = 'Move down';
                down.textContent = '↓';

                item.append(up, down);
            }

            const remove = document.createElement('button');
            remove.className = 'remove-file-btn';
            remove.dataset.i = i;
            remove.textContent = 'Remove';
            item.appendChild(remove);

            el.appendChild(item);
        });

        el.querySelectorAll('.remove-file-btn').forEach(btn => btn.addEventListener('click', e => {
            selectedFiles.splice(parseInt(e.target.dataset.i), 1);
            updateFileList();
            if (!selectedFiles.length) document.getElementById('process-btn').disabled = true;
        }));

        el.querySelectorAll('.file-reorder-btn').forEach(btn => btn.addEventListener('click', e => {
            const i = parseInt(e.currentTarget.dataset.i);
            const dir = e.currentTarget.dataset.action === 'up' ? -1 : 1;
            const j = i + dir;
            if (j < 0 || j >= selectedFiles.length) return;
            [selectedFiles[i], selectedFiles[j]] = [selectedFiles[j], selectedFiles[i]];
            updateFileList();
        }));
    }

    function showLoader(text = 'Processing…') {
        document.getElementById('loader-text').textContent = text;
        document.getElementById('loader-overlay').style.display = 'flex';
    }

    function hideLoader() {
        document.getElementById('loader-overlay').style.display = 'none';
    }

    function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3200);
    }

    function showOutputMessage(msg) {
        const out = document.getElementById('output-area');
        out.innerHTML = '';
        const message = document.createElement('div');
        message.style.cssText = 'padding:14px;background:var(--bg);border-radius:8px;font-size:.88rem;color:var(--muted);margin-top:16px';
        message.textContent = msg;
        out.appendChild(message);
    }

    function createDownloadLink(data, filename, type) {
        const blob = new Blob([data], { type });
        const url = URL.createObjectURL(blob);
        const out = document.getElementById('output-area');
        out.innerHTML = '';
        const link = document.createElement('a');
        link.className = 'dl-btn';
        link.href = url;
        link.download = filename;
        link.textContent = `Download ${filename}`;
        out.appendChild(link);
    }

    // ── UI UTILITIES ──────────────────────────────────────────────────────
    window.addEventListener('scroll', () =>
        document.getElementById('header').classList.toggle('scrolled', window.scrollY > 50)
    );

    const ham = document.getElementById('hamburger');
    const nav = document.getElementById('nav-links');
    ham.addEventListener('click', () => { ham.classList.toggle('active'); nav.classList.toggle('active'); });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
        ham.classList.remove('active'); nav.classList.remove('active');
    }));
});

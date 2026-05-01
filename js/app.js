document.addEventListener('DOMContentLoaded', () => {
    const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js`;

    let currentToolId = null;
    let selectedFiles = [];
    const MAX_FILE_SIZE_MB = 100;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

    // ── PDF PREVIEW STATE ─────────────────────────────────────────────────
    let previewPDFDoc = null;
    let previewCurrentPage = 1;
    let previewRendering = false;
    let previewPendingPage = null;

    // ── TOOL DEFINITIONS ────────────────────────────────────────────────
    const toolImplementations = {

        'pdf-table-to-excel': {
            title: 'PDF Tables → Excel',
            desc: 'Extract all tables from a PDF and export each as an Excel sheet.',
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
            `,
            process: async (options) => {
                showLoader('Loading PDF…');
                const pdfBytes = await selectedFiles[0].arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
                const numPages = pdf.numPages;
                const sensitivity = parseInt(options['tbl-sensitivity']) || 3;
                const useHeader = options['tbl-header-row'] !== false && options['tbl-header-row'] !== 'false';

                const allTables = [];

                for (let p = 1; p <= numPages; p++) {
                    showLoader(`Scanning page ${p} of ${numPages}…`);
                    const page = await pdf.getPage(p);
                    const content = await page.getTextContent();
                    const tables = extractTablesFromTextContent(content, sensitivity);
                    tables.forEach((t, i) => allTables.push({ pageNum: p, tableIndex: i + 1, rows: t }));
                }

                if (allTables.length === 0) {
                    hideLoader();
                    showOutputMessage('⚠️ No tables detected in this PDF. Try increasing sensitivity or check that the PDF has selectable text.');
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
                createDownloadLink(bytes, 'merged.pdf', 'application/pdf');
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
                showLoader('Splitting PDF…');
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
                createDownloadLink(bytes, 'split.pdf', 'application/pdf');
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
                createDownloadLink(bytes, 'compressed.pdf', 'application/pdf');
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
                showLoader('Rotating…');
                const angle = parseInt(options['rotation-angle']);
                const bytes = await selectedFiles[0].arrayBuffer();
                const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                doc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + angle) % 360)));
                createDownloadLink(await doc.save(), 'rotated.pdf', 'application/pdf');
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
                    <label for="page-num-position">Position</label>
                    <select id="page-num-position">
                        <option value="bottom-center">Bottom Center</option>
                        <option value="bottom-left">Bottom Left</option>
                        <option value="bottom-right">Bottom Right</option>
                        <option value="top-center">Top Center</option>
                        <option value="top-left">Top Left</option>
                        <option value="top-right">Top Right</option>
                    </select>
                </div>
                <div class="option-group">
                    <label for="page-num-format">Format ({page} and {total})</label>
                    <input type="text" id="page-num-format" value="Page {page} of {total}">
                </div>
            `,
            process: async (options) => {
                showLoader('Adding page numbers…');
                const bytes = await selectedFiles[0].arrayBuffer();
                const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                const font = await doc.embedFont(StandardFonts.Helvetica);
                const pages = doc.getPages();
                const total = pages.length;
                pages.forEach((page, i) => {
                    const { width, height } = page.getSize();
                    const text = options['page-num-format'].replace('{page}', i + 1).replace('{total}', total);
                    const sz = 12, tw = font.widthOfTextAtSize(text, sz);
                    const pos = options['page-num-position'];
                    const m = 30;
                    let x = pos.includes('left') ? m : pos.includes('right') ? width - tw - m : width / 2 - tw / 2;
                    let y = pos.includes('top') ? height - m - sz : m;
                    page.drawText(text, { x, y, size: sz, font, color: rgb(0, 0, 0) });
                });
                createDownloadLink(await doc.save(), 'numbered.pdf', 'application/pdf');
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
                showLoader('Adding watermark…');
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
                createDownloadLink(await doc.save(), 'watermarked.pdf', 'application/pdf');
            }
        },

        'protect-pdf': {
            title: 'Protect PDF',
            desc: 'Password-encrypt your PDF file.',
            icon: '🔒',
            category: 'Security',
            fileType: '.pdf',
            multiple: false,
            options: () => `
                <div class="option-group">
                    <label for="user-password">Open password</label>
                    <input type="password" id="user-password" placeholder="Leave blank if not needed">
                </div>
                <div class="option-group">
                    <label for="owner-password">Owner (permissions) password *</label>
                    <input type="password" id="owner-password" placeholder="Required">
                </div>
            `,
            process: async (options) => {
                showLoader('Protecting PDF…');
                if (!options['owner-password']) throw new Error('Owner password is required.');
                const bytes = await selectedFiles[0].arrayBuffer();
                const doc = await PDFDocument.load(bytes);
                createDownloadLink(
                    await doc.save({ userPassword: options['user-password'], ownerPassword: options['owner-password'] }),
                    'protected.pdf', 'application/pdf'
                );
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
                showLoader('Converting…');
                const doc = await PDFDocument.create();
                for (const f of selectedFiles) {
                    const img = await doc.embedJpg(await f.arrayBuffer());
                    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
                }
                createDownloadLink(await doc.save(), 'converted.pdf', 'application/pdf');
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
                showLoader('Converting…');
                const doc = await PDFDocument.create();
                for (const f of selectedFiles) {
                    const img = await doc.embedPng(await f.arrayBuffer());
                    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
                }
                createDownloadLink(await doc.save(), 'converted.pdf', 'application/pdf');
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
                showLoader('Converting…');
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
            desc: 'Extract all text from a PDF into a DOCX.',
            icon: '📝',
            category: 'Convert',
            fileType: '.pdf',
            multiple: false,
            process: async () => {
                showLoader('Extracting text…');
                const bytes = await selectedFiles[0].arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                let allText = '';
                for (let i = 1; i <= pdf.numPages; i++) {
                    showLoader(`Reading page ${i}/${pdf.numPages}…`);
                    const pg = await pdf.getPage(i);
                    const content = await pg.getTextContent();
                    allText += content.items.map(it => it.str).join(' ') + '\n\n';
                }
                showLoader('Building DOCX…');
                const paragraphs = allText.split('\n').map(t => new docx.Paragraph({ children: [new docx.TextRun(t)] }));
                const d = new docx.Document({ sections: [{ children: paragraphs }] });
                createDownloadLink(await docx.Packer.toBlob(d), 'extracted.docx',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
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
                showLoader('Converting…');
                const result = await mammoth.convertToHtml({ arrayBuffer: await selectedFiles[0].arrayBuffer() });
                const el = document.createElement('div');
                el.innerHTML = sanitizeHtml(result.value);
                const blob = await html2pdf().from(el).set({
                    margin: [15, 15, 15, 15], filename: 'converted.pdf',
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                }).output('blob');
                createDownloadLink(blob, 'converted.pdf', 'application/pdf');
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
                showLoader('Converting…');
                const wb = XLSX.read(await selectedFiles[0].arrayBuffer(), { type: 'buffer' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const el = document.createElement('div');
                el.innerHTML = sanitizeHtml(XLSX.utils.sheet_to_html(ws));
                const style = document.createElement('style');
                style.textContent = `table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:10px}th,td{border:1px solid #ddd;text-align:left;padding:4px}th{background:#f2f2f2;font-weight:bold}`;
                el.prepend(style);
                const blob = await html2pdf().from(el).set({
                    margin: 10, filename: 'from_excel.pdf',
                    html2canvas: { scale: 2 },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
                }).output('blob');
                createDownloadLink(blob, 'from_excel.pdf', 'application/pdf');
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
                    <div style="font-size:.82rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
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
    async function initPDFPreview(file) {
        const panel = document.getElementById('pdf-preview-panel');
        panel.style.display = 'block';
        document.getElementById('preview-loading').style.display = 'flex';
        document.getElementById('pdf-preview-canvas').style.display = 'none';
        document.getElementById('preview-thumb-strip').innerHTML = '';

        const arrayBuffer = await file.arrayBuffer();
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
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

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
        }
        modal.style.display = 'block';
    }

    function closeModal() { modal.style.display = 'none'; resetModal(); }

    function resetModal() {
        selectedFiles = []; updateFileList();
        document.getElementById('tool-options').innerHTML = '';
        document.getElementById('output-area').innerHTML = '';
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
        selectedFiles.forEach((f, i) => {
            const item = document.createElement('div');
            item.className = 'file-item';
            const name = document.createElement('span');
            name.className = 'file-item-name';
            name.textContent = `File: ${f.name}`;
            const remove = document.createElement('button');
            remove.className = 'remove-file-btn';
            remove.dataset.i = i;
            remove.textContent = 'Remove';
            item.append(name, remove);
            el.appendChild(item);
        });
        el.querySelectorAll('.remove-file-btn').forEach(btn => btn.addEventListener('click', e => {
            selectedFiles.splice(parseInt(e.target.dataset.i), 1);
            updateFileList();
            if (!selectedFiles.length) document.getElementById('process-btn').disabled = true;
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

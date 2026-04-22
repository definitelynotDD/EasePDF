# easePDF Toolkit 🧰

> A complete suite of **free, private, client-side PDF tools** — all processing happens in your browser. No file uploads. No server. No cost.

![easePDF Toolkit Preview](assets/preview.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://vercel.com)
![Made with HTML CSS JS](https://img.shields.io/badge/Built%20with-HTML%20%7C%20CSS%20%7C%20JS-orange)

---

## ✨ Features

| Category   | Tools |
|------------|-------|
| 📦 Organize | Merge PDF, Split PDF, Rotate PDF |
| ✏️ Edit     | Add Page Numbers, Watermark PDF |
| 🔒 Security | Protect PDF (password encryption) |
| 🔄 Convert  | JPG→PDF, PNG→PDF, PDF→JPG, PDF→Word, Word→PDF, Excel→PDF |
| 📊 Extract  | PDF Tables → Excel (multi-sheet) |
| ⚙️ Optimize | Compress PDF |

All tools run **100% in the browser** using WebAssembly and JavaScript — your files never leave your device.

---

## 🚀 Live Demo

🔗 [https://easepdf-toolkit.vercel.app](https://easepdf-toolkit.vercel.app) *(update with your Vercel URL)*

---

## 📁 Project Structure

```
easepdf-toolkit/
│
├── index.html          # HTML structure and library <script> tags only
├── css/
│   └── style.css       # All custom styling
├── js/
│   └── app.js          # All JavaScript logic (tools, preview, UI)
├── assets/
│   └── preview.png     # Screenshot used in this README
│
├── .gitignore          # Ignores system & editor files
├── LICENSE             # MIT License
└── README.md           # This file
```

---

## 🛠️ Tech Stack

- **[pdf-lib](https://pdf-lib.js.org/)** — Create and modify PDFs
- **[PDF.js](https://mozilla.github.io/pdf.js/)** — Render PDF pages for preview & conversion
- **[SheetJS (xlsx)](https://sheetjs.com/)** — Excel file generation
- **[mammoth.js](https://github.com/mwilliamson/mammoth.js)** — DOCX → HTML conversion
- **[html2pdf.js](https://github.com/eKoopmans/html2pdf.js)** — HTML → PDF rendering
- **[docx](https://github.com/dolanmiu/docx)** — DOCX file creation
- **[JSZip](https://stuk.github.io/jszip/)** — ZIP bundling for multi-file exports
- **[Syne](https://fonts.google.com/specimen/Syne) + [DM Sans](https://fonts.google.com/specimen/DM+Sans)** — Typography via Google Fonts

---

## 🏃 Run Locally

No build step required. Just open the file:

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/easepdf-toolkit.git
cd easepdf-toolkit

# Open directly in browser (no server needed)
open index.html
```

Or use a simple local server for best results:

```bash
# Python
python -m http.server 3000

# Node (npx)
npx serve .
```

Then visit `http://localhost:3000`.

---

## ☁️ Deploy to Vercel

This is a **pure static site** — no build step, no backend.

### Option 1: Via Vercel Dashboard (easiest)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project**
3. Import your GitHub repository
4. Set **Framework Preset** to `Other`
5. Leave build settings blank
6. Click **Deploy** ✅

### Option 2: Via Vercel CLI

```bash
npm i -g vercel
vercel --prod
```

---

## 🤝 Contributing

Contributions are welcome! To add a new tool:

1. Fork the repo and create a new branch: `git checkout -b feature/my-new-tool`
2. Add your tool definition inside the `toolImplementations` object in `js/app.js`
3. Follow the existing structure: `title`, `desc`, `icon`, `category`, `fileType`, `options()`, `process()`
4. Test it locally, then open a pull request

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<p align="center">Made with ❤️ · All processing happens in your browser · No data ever leaves your device</p>

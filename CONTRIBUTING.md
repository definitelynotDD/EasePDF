# Contributing to easePDF Toolkit

Thanks for your interest in contributing! 🎉 This project is intentionally
dependency-light and **build-step-free**, so getting started is quick.

## Getting started

```bash
git clone https://github.com/definitelynotDD/EasePDF.git
cd EasePDF
python -m http.server 3000   # or: npx serve .
```

Open `http://localhost:3000` and you're running the full frontend.

For the optional native OCR backend, see [`server/README.md`](server/README.md).

## Adding a new tool

Every tool is a single entry in the `toolImplementations` object in
[`js/app.js`](js/app.js). The grid, modal, file handling, and PDF preview are
all generated from that object — you don't touch the HTML. Follow the existing
shape:

```js
'my-new-tool': {
    title: 'My New Tool',
    desc: 'Short description shown on the card.',
    icon: '🧩',
    category: 'Organize',        // Organize | Edit | Security | Convert | Extract | Optimize
    fileType: '.pdf',            // accepted extensions
    multiple: false,             // allow multiple files?
    options: () => `...`,        // optional: HTML for tool options
    process: async (options) => {
        // do the work, then call createDownloadLink(...) or render output
    }
}
```

Tips:
- Use `showLoader()` / `hideLoader()` for progress and `showToast()` for messages.
- Sanitize any injected HTML with `sanitizeHtml()` (DOMPurify) — never insert raw user content.
- Keep processing client-side unless there's a strong reason not to.

## Pull request checklist

- [ ] Tested locally in the browser (and the backend, if touched).
- [ ] `node --check js/app.js` passes (CI runs this).
- [ ] Code matches the surrounding style (indentation, naming, no new deps unless necessary).
- [ ] Updated the README/docs if behavior changed.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/definitelynotDD/EasePDF/issues/new/choose).
For security issues, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

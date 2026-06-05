# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please **do not open a public issue**.
Instead, report it privately to **dasdevanshu370@gmail.com** with:

- A description of the issue and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Any suggested remediation

You can expect an acknowledgement within a few days. Please give a reasonable
window to address the issue before any public disclosure.

## Scope & design notes

- **Standard tools are 100% client-side.** Files are processed in the browser
  and never uploaded, which removes a large class of server-side risks.
- **Native OCR backend** ([`server/`](server/README.md)) is the only component
  that receives user files. It runs in an isolated container, writes uploads to
  a temporary directory, and deletes them after processing.
- The frontend ships a strict **Content-Security-Policy** (see `vercel.json`)
  that whitelists only the required script/connect/worker origins.
- User-supplied content rendered in the DOM is sanitized with **DOMPurify**.

## Supported versions

This is a single actively-maintained deployment; fixes are applied to `main`
and deployed continuously.

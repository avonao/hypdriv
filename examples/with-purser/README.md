# Hypdriv × Purser CSS — Cloudflare example

Next.js 16 (Cache Components on) on Cloudflare Workers with OpenNext, Hypdriv and [Purser CSS](https://github.com/avonao/purser).

```sh
pnpm install
pnpm dev                 # next dev: Purser watches and rebuilds app/purser.css
pnpm preview             # opennextjs-cloudflare build + preview (the Worker shell)
pnpm audit:css           # zero-override audit in headless Chrome against the preview
pnpm hypdriv:audit       # headers, CSP, cache and CSS audits against the preview
```

Copy `.dev.vars.example` to `.dev.vars` before `pnpm preview`.

- `withHypDriv` builds `app/purser.css` before `next build` and fails the build when prerendered HTML references an atom the stylesheet does not declare.
- The configuration uses Purser 0.2: minimal class names (`names: 'min'`), one class per rule, a minified stylesheet and fused classes (`fuse: 'exact'`). `withHypDriv` gives Turbopack Purser's loader, so the pages ship class names and no style code; the names are kept in `node_modules/.cache/purser/names.json` between builds.
- The Worker pins the theme classes on `<html>` at the edge from the `hyp_theme` cookie or `Sec-CH-Prefers-*` client hints; `ThemeScript` (hashed into the CSP) does the same on other runners.
- Static pages get a hash-based CSP, cached pages get edge-injected nonces, Early Hints preload the stylesheet.

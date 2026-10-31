---
"@hypdriv/security": patch
"@hypdriv/purser": patch
"@hypdriv/cloudflare": patch
"@hypdriv/cli": patch
---

Proxy runner and tooling fixes found by end-to-end runs on workerd, `next start` and `vercel build`.

- The `csp` stage sets the response policy on Next.js pass-through responses in `proxy.ts` (page routes have no content type yet there), and the Purser `theme` stage adds its negotiation headers there too.
- `loadNodeScrypt` no longer leaves a literal `node:crypto` import in bundles (Edge-runtime build warnings).
- `@hypdriv/cloudflare` builds without bare chunk imports (wrangler's `ignored-bare-import` warning).
- CLI: the CSP audit treats Hypdriv's declared `'unsafe-inline'` fallback for cached HTML as a warning; the cache audit revisits like a browser (cookies from the first response), reads `x-vercel-cache` and checks planned Vercel CDN headers; `doctor` checks `HYPDRIV_INTERNAL_SECRET` on Vercel when queues are configured.

---
'@hypdriv/vercel': patch
'@hypdriv/security': patch
---

Vercel: a document with a per-request CSP nonce no longer reaches the CDN. Policies that force caching (`respectOrigin: false`) serve their dynamic pages with the documented `'unsafe-inline'` script fallback instead of a nonce the CDN would hand to the next visitor (which blocked every inline script); policies that respect the origin send no CDN headers for nonce documents (`uncacheable:nonce`), and a function that owns the response has shared-cache headers on a nonce document replaced with `private, no-cache`. `@hypdriv/security` exports `demoteNonceForSharedCache()` for platforms whose shared cache stores the application's response.

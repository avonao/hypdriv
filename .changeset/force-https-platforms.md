---
"@hypdriv/runtime": minor
"@hypdriv/cloudflare": minor
"@hypdriv/next": minor
---

`redirects.forceHttps: 'auto'` (the default) is now on for Cloudflare and Vercel deployments when `site.origin` is not set — their edge terminates TLS for every hostname and Hypdriv sends HSTS by default, so serving pages over plain HTTP contradicted the policy. An explicit `site.origin` still decides by its scheme, Node servers keep plain HTTP unless configured, and local hosts and development stay exempt. Found on a live Vite deployment that served `/` over `http://` with an HSTS header.

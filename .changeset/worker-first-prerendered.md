---
"@hypdriv/tanstack-start": minor
---

`createStartWorker()` answers GET/HEAD requests from the assets binding first (`assets: false` turns it off), so with `assets.run_worker_first` prerendered pages get the request stages on Cloudflare while still being served as built, with their build-time hash CSP (the build manifest is used instead of the rendered one). The example routes everything but `/assets/*` through the Worker.

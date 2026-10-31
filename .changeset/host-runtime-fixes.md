---
"@hypdriv/core": patch
"@hypdriv/runtime": patch
"@hypdriv/build": patch
---

Fixes from integrating seven Vite frameworks: the Workers-only `cloudflare:workers` import is computed at run time, so Node and Vercel bundles (Rolldown const inlining, Vercel's file tracer) no longer pick it up; forwarding a request with the pipeline's headers works with srvx's lazy `Request` look-alikes (Nitro's Node presets, `@vitejs/plugin-rsc`'s dev server), which `new Request(input, init)` rejected with a 500; Early Hints and static `Link` headers announce the ES modules of Vite builds as `modulepreload` instead of `preload; as=script`, which made module scripts download twice.

---
"@hypdriv/qwik": minor
"@hypdriv/core": minor
"@hypdriv/cli": minor
"create-hypdriv": minor
"@hypdriv/vite": patch
---

New package: Hypdriv for Qwik (Qwik v2 release candidates with Qwik Router, on Vite) on Cloudflare Workers, Vercel and Node. `hypdriv()` in `vite.config.ts` (next to `qwikRouter()` and `qwikVite()`) writes the route manifest from Qwik Router's route table, the CSP hashes of prerendered pages, the platform's static headers, the Vercel Routing Middleware for CDN-served pages and the final manifest in every server output, and runs the Drivetrain around the dev server. `@hypdriv/qwik/adapters/node|vercel|cloudflare` are Qwik Router adapters (`viteAdapter`) that keep Qwik's static generation and write the platform output, and `@hypdriv/qwik/middleware/node|vercel|cloudflare` export `createQwikRouter()` for `src/entry.<platform>.tsx`: Qwik Router's request handler behind the Drivetrain on every platform (Hypdriv's Worker shell with the Durable Object classes on Cloudflare, a streaming Node.js function on Vercel, a Node listener that also serves the client build). `@hypdriv/qwik/server` provides `hyp()`, `nonce()`, `flag()`, `geo()`, `defer()` and `jobHandler()` for loaders, actions, `server$` and endpoints. `hypdriv init` adds the plugin (function-form Vite configs included) with the adapter, entry and wrangler settings of the chosen platform, `hypdriv doctor` gets the `qwik.version`, `qwik.vite`, `qwik.adapter`, `qwik.entry`, `qwik.worker`, `qwik.vercel-outdir` and `qwik.loader-json` checks (Qwik v1 is reported with the `qwik migrate-v2` hint), `create-hypdriv --framework qwik` scaffolds `examples/qwik` for any platform, and `@hypdriv/core`'s `FrameworkName` gains `qwik`. `@hypdriv/vite/node`'s `sendWebResponse` now keeps the response's status text.

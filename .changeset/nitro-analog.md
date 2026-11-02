---
"@hypdriv/nitro": minor
"@hypdriv/analog": minor
"@hypdriv/core": minor
"@hypdriv/cli": minor
"create-hypdriv": minor
---

New packages: Hypdriv for Nitro (Nitro 2 `nitropack` 2.13 and Nitro 3 `nitro/vite`, 3.0.261029-rc) and for Analog (the Angular meta-framework on Vite and Nitro, 2.9), on Cloudflare Workers, Vercel and Node (ADR 0027).

`@hypdriv/nitro` is the shared Nitro layer. `hypdrivNitro()` is a Nitro module (`modules` in `nitro.config.ts`; for Nitro 3 with Vite the `hypdriv()` plugin from `@hypdriv/nitro/vite` carries it) that wraps Nitro's request handler with the Drivetrain: request stages first, then Nitro renders into a captured response that the response stages post-process, errors included. It writes the route manifest from Nitro's handlers and prerendered documents, the CSP hashes of prerendered pages, the static headers (Cloudflare `_headers`, Vercel Build Output routes), the final manifest in every server file, and a Routing Middleware for prerendered pages on Vercel. `cloudflare-module` gets Hypdriv's Worker shell with the Hypdriv Durable Objects exported (`cloudflare.exports` adds your own); hashed assets get an immutable `Cache-Control`. `@hypdriv/nitro/server` provides `hyp()`, `requireHyp()`, `nonce()`, `flag()`, `geo()`, `defer()` and `jobHandler()` for route handlers, and the development server runs the pipeline too (including the Cloudflare development Worker of Nitro 3).

`@hypdriv/analog` adds Analog's file router and content routes to the manifest, per-page client assets and Early Hints from the Vite client manifest, `withHypDriv()` around the `analog()` options, and the Angular side: `provideHypDriv()` (Angular `CSP_NONCE`, an `ngCspNonce` root attribute, the request context) from `@hypdriv/analog/angular/server`, and the browser-safe `injectHyp()` from `@hypdriv/analog/angular`.

`hypdriv init` registers the module, the Vite plugins and `provideHypDriv()`; `hypdriv doctor` gets the `nitro.cloudflare-preset`, `analog.tsconfig-emit` and `analog.server-providers` checks; `create-hypdriv --framework nitro|analog` scaffolds `examples/nitro` and `examples/analog` for any platform (`examples/nitro-vite` is the Nitro 3 variant); `@hypdriv/core`'s `FrameworkName` gains `nitro` and `analog`.

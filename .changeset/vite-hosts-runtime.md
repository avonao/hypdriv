---
"@hypdriv/runtime": minor
"@hypdriv/build": minor
"@hypdriv/core": minor
"@hypdriv/next": minor
"@hypdriv/cloudflare": minor
"@hypdriv/security": minor
"@hypdriv/vercel": minor
"@hypdriv/cache": minor
---

One runtime and one build engine for every framework (ADR 0019). `@hypdriv/runtime` holds the Drivetrain stages, the platform wiring per deploy target, the routing-middleware runner (`createProxyHandler()`) and `createHandler()`, the runner for hosts that own the full response (any Web fetch handler; `/_hypdriv/*`, https upgrade, build-asset skip, `AsyncLocalStorage` context for `hyp()`, pass-through under an outer HypDriv runner). `@hypdriv/build` holds the manifest assembly (`assembleManifest()`) and static header rules for responses the platform serves without application code (security preset, hash CSP per prerendered document marked `x-hypdriv-csp`, Early Hints, immutable assets) rendered for Cloudflare `_headers` (within the 100-rule/2000-character limits, merged with existing rules) and Vercel Build Output routes. `@hypdriv/next` builds on both without API changes; the Cloudflare shell accepts any application worker (`createWorker({ app })`). The manifest records its producer (`framework`), optional-segment patterns (`[[name]]`), `endpoint` routes, `fallback` shells and `servedStatically` documents (neither is edge-cached by inference). The CSP stage injects nonces with a portable streaming tokenizer where `HTMLRewriter` is missing (`injectNonceStream()`), and replaces a static `_headers` policy instead of treating it as the application's. The Vercel CDN stage applies every page policy when the function owns the response (`responseOwner`).

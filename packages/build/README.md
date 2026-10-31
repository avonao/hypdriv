# @hypdriv/build

[Hypdriv](https://github.com/avonao/hypdriv)'s framework-neutral build engine (Node). Framework integrations discover routes and prerendered documents; `assembleManifest()` turns them into `.hypdriv/manifest.json`:

- client assets per route (from the framework's build manifest, merged with what the HTML references),
- CSP hashes of every prerendered document's inline scripts and styles,
- Early Hints `Link` values, the speculation graph (same-origin links per route),
- Purser verification (no unstyled atom ships) and the client secrets scan,
- client weights and budgets, Hypdriv's own inline-script hashes, the content fingerprint and inferred cache policies.

`staticHeaderRules()` computes the headers of responses the platform serves without application code — the security preset, each prerendered document's hash CSP (a static file cannot carry a nonce), Early Hints and immutable caching for content-hashed assets — and `renderCloudflareHeaders()` / `mergeVercelRoutes()` write them into Cloudflare's `_headers` (within its 100-rule limit, merged with existing rules) and Vercel's Build Output `config.json`.

Used by the Next.js adapter (`@hypdriv/next/adapter`) and by `@hypdriv/vite` and the framework packages built on it.

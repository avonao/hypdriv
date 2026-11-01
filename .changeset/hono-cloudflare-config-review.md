---
"@hypdriv/hono": patch
"@hypdriv/security": patch
"@hypdriv/core": patch
"@hypdriv/runtime": patch
"@hypdriv/cli": patch
---

Review fixes for the Hono host, `cloudflare.config.ts` reading and `routes --diff`.

- Hono: the middleware hands the pipeline's request (with its body and sanitised `x-hypdriv-*` headers) to the app, so POST bodies work; `useHypDriv(app)` and `wrapHono(app)` revalidate stale pages through the app (a plain `hypdriv()` without the app keeps serving the stale page and says why); Bun's `server.requestIP` and Deno's `remoteAddr` give the client address and are no longer mistaken for the environment; IPv4-mapped IPv6 addresses (`::ffff:203.0.113.9`) match IPv4 allow lists.
- Security: nonce injection decodes gzip/deflate HTML (and leaves other encodings untouched, with a warning) instead of corrupting compressed bytes.
- CLI: `cloudflare.config.ts` evaluation returns its result through a file (stdout noise and lingering timers no longer matter), reports thrown error messages and missing imports, accepts `worker` as a function or promise, reads entries that are not built yet, handles Windows paths and the Durable Object `renamed` / `transferred` states, and no longer passes credential-named environment variables to the config. `doctor` `hono.order` ignores comments, strings and unrelated `.all()` / `.get()` calls and only counts routes of the app the middleware is registered on.
- CLI: `routes --diff` pairs a route whose kind changed by its path, treats a halved `revalidate` or most prerendered paths vanishing as regressions, refuses incomplete baselines and baselines sharing no route with exit code 2 (regressions stay 1), and tolerates manifests without `weights`, `earlyHints` or `csp`.

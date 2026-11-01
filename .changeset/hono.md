---
"@hypdriv/hono": minor
"@hypdriv/core": minor
"@hypdriv/cli": minor
"create-hypdriv": minor
---

New package: Hypdriv for Hono on Cloudflare Workers, Vercel Functions, Node, Bun and Deno. `useHypDriv(app, { config })` registers the Drivetrain as Hono middleware (security headers, CSP with per-request nonces, rate limiting, bot shield, geo, flags, redirects, Early Hints, logging, `Server-Timing`, `/_hypdriv/*`); `wrapHono(app, { config })` wraps the whole app's `fetch` and forwards the pipeline's request. The route manifest is derived from `app.routes` (`honoManifest()`), the request's nonce is `nonce()` and `c.get('hypdrivNonce')`, and the response replacement avoids `Context#res` merging the application's old headers back over the pipeline's. `hypdriv init` registers the middleware in an existing entry (or writes one) with the Durable Objects and wrangler settings, `hypdriv doctor` gets the `hono.integration`, `hono.registered` and `hono.order` checks, `create-hypdriv --framework hono` scaffolds `examples/hono` for any platform, and `@hypdriv/core`'s `FrameworkName` gains `hono`.

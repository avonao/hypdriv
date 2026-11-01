# ADR 0020 — Hono: a server-framework host without a build step

**Status:** accepted · **Date:** 2026-11-01

## Context

ADR 0019 made every Vite framework a host of one runtime (`createHandler()`) and one build engine (`@hypdriv/build`). Those hosts share a build: routes are discovered, documents prerendered, the manifest finalised and patched into the server bundle. [Hono](https://hono.dev) is different. It is a Web-standards server framework for Cloudflare Workers, Vercel Functions, Node, Bun and Deno; apps are plain modules, usually bundled by the platform tooling (Wrangler, Vercel's zero-config Hono, `tsx`/Node), with no build step Hypdriv could attach to and no prerendered documents. It is widely used for APIs and server-rendered sites on exactly the platforms Hypdriv targets, and its request model (`app.fetch(request, env, ctx)`) is the one `createHandler()` already wraps.

## Decision

1. **`@hypdriv/hono` is a thin host over `createHandler()`**, with two entry points that produce the same pipeline-managed response: `useHypDriv(app, { config })` / `hypdriv({ config })` as Hono middleware, and `wrapHono(app, { config })` as a wrapper around the app's `fetch`. Both run with `runner: 'host'` and the host label `hono`.
2. **The middleware owns the response, and replaces it through a cleared `c.res`.** Hono's `Context#res` setter merges the old response's headers back into a new one, which would restore headers the Drivetrain just removed or rewrote (`x-powered-by`, a rewritten `Cache-Control`). The middleware therefore sets `c.res = undefined` before assigning the pipeline's response. A regression test covers it and was mutation-checked.
3. **The wrapper is the form that can rewrite the request.** A Hono middleware can only replace the response; `wrapHono()` forwards the pipeline's request (sanitised headers, the stages' `x-hypdriv-*` headers) to `app.fetch`. `hypdriv doctor` (`hono.order`) fails when a route is registered before the middleware, because Hono middleware wraps only the routes registered after it.
4. **The manifest is derived from `app.routes`**, evaluated when the handler first runs (`honoManifest()`): one dynamic endpoint per path, `/users/:id` → `/users/[id]`, `:id{re}` → `[id]`, `:lang?` → `[[lang]]`, a trailing `*` → `[...splat]`, `ALL` with a trailing wildcard (`app.use('/api/*')`) skipped as middleware. A build-time manifest can be passed instead. Everything is "rendered per request": the CSP is always nonce mode and caching is opt-in through policies.
5. **Platform facts come from the call, not from the environment.** Cloudflare bindings arrive as `c.env` and `waitUntil` through `c.executionCtx` (guarded: Hono throws on runtimes without a context). `@hono/node-server` passes `{ incoming, outgoing }` as the bindings, which is not an environment; the socket address is the client IP unless `security.trustedProxies > 0`, in which case the forwarded headers decide.
6. **Tooling follows the other hosts.** `FrameworkName` gains `hono`; `hypdriv init` registers the middleware in an existing entry or writes one (with the Durable Object re-exports and wrangler settings on Cloudflare); `hypdriv doctor` gets `hono.integration`, `hono.registered` and `hono.order`; `create-hypdriv --framework hono` scaffolds `examples/hono` for every platform; `e2e/hosts` verifies a deployed Hono app with `--framework hono`.

## Consequences

- One more package (`@hypdriv/hono`, peer `hono >=4.6 <5`), no change to the stages, the manifest format or the release bundle (which packs every package under `packages/`; the Next.js install set is unchanged).
- Because there is no build, there is no static header layer, no CSP hash mode, no Purser integration step and no `hypdriv budget`; `hypdriv audit` and `hypdriv routes` work against a running app.
- The route manifest only knows what the app registered when the first request arrives; routes added later (dynamic `app.route()` after start) are not in it.
- Verified locally on Node (`@hono/node-server`) and workerd (`wrangler dev`) with the audit; live Cloudflare and Vercel runs remain pending (`docs/preview-status.md`).

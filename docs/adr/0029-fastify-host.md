# ADR 0029 — Fastify: lifecycle hooks around a plugin framework, Node and Vercel only

**Status:** accepted · **Date:** 2026-11-10

## Context

Fastify is the second large Node server framework after Express. It has a different shape again: routes live in an encapsulated plugin tree, the request lifecycle is a fixed sequence of hooks (`onRequest` … `onSend`), payloads are serialised before `onSend` and replaced by returning a new payload from it, routes registered before a plugin are invisible to that plugin's `onRoute` hook, and the ecosystem (`@fastify/static`, `@fastify/compress`, `@fastify/etag`, `@fastify/websocket`, `@fastify/formbody`) plugs into the same hooks. Fastify's router (`find-my-way`) compiles handlers with `new Function()`.

## Decision

1. **`@hypdriv/fastify` is one encapsulation-breaking plugin over `createHandler()`** (wrapped with `fastify-plugin`, so its hooks reach every route and nested plugin), using the Node bridge of `@hypdriv/runtime/node` (ADR 0028).
2. **`onRequest` runs the stages before the app; `onSend` hands the reply to the stages after it.** The callback-style `onRequest` hook starts the pipeline; its `upstream` releases the body, syncs the pipeline's request headers onto the Node request, sets `request.hypdrivNonce` and calls `done()`, so the route runs inside the pipeline's request scope (`hyp()`, `nonce()`). The async `onSend` hook turns the payload into a streaming Web `Response`, resolves the pipeline's upstream with it and returns the pipeline's final response as the new payload. A small state machine (pending, proceeded, answered, failed, settled) covers the pipeline answering itself (rate limits, internal routes, the HTTPS upgrade), errors and closed connections. Fastify's generated `HEAD` routes need a non-null payload, so `HEAD` answers with an empty stream.
3. **Hijacked replies settle the pipeline with an empty stand-in.** `reply.hijack()` and WebSocket upgrades never reach `onSend`; the request stages ran, the response phase is skipped and the app owns the socket.
4. **Order rules are the hooks' rules.** The plugin's hooks apply regardless of when routes were registered; other `onSend` hooks run in registration order, so `@fastify/compress` belongs after the plugin (it logs a warning and `hypdriv doctor` fails `fastify.order` otherwise), and payload readers such as `@fastify/etag` before it. Conditional headers are dropped from nonce-carrying HTML navigations, as for Express.
5. **The manifest comes from `onRoute` plus the router tree.** Routes registered after the plugin arrive through `onRoute` with their prefixes; routes registered before it are read back from `printRoutes()` when the plugin loads. find-my-way syntax maps to Hypdriv patterns (`:id` → `[id]`, `*` → `[...splat]`, an optional last parameter → two patterns, regexp constraints ignored). Stale-while-revalidate renders with `fastify.inject()`, marked with a per-process token the plugin recognises.
6. **Node and Vercel; Cloudflare Workers is refused, not emulated.** On Vercel, zero-config Fastify serves the server `listen()` starts (captured by the runtime after the module has loaded, so `listen()` must not be awaited at the top level), and its preset does not publish `public/**`, so `@fastify/static` serves it from the Function. On Workers, `find-my-way`'s `new Function()` fails ("Code generation from strings disallowed") and the plugin loader cannot finish in a Worker's global scope (both reproduced with `wrangler dev` and `httpServerHandler()`); `hypdriv init`, `create-hypdriv` and `hypdriv doctor` (`fastify.workers`) say so and point to Hono.
7. **Tooling follows the other hosts.** `FrameworkName` gains `fastify` (declared dependency only); `hypdriv init` registers the plugin after `Fastify()` and defaults to Node; `hypdriv doctor` gets `fastify.integration`, `fastify.version`, `fastify.registered`, `fastify.order`, `fastify.vercel-entry` and `fastify.workers`; `create-hypdriv --framework fastify` scaffolds `examples/fastify` for Node and Vercel.

## Consequences

- One more package (`@hypdriv/fastify`, peer `fastify >=5 <6`); no change to the stages or the manifest format.
- Fastify 4 is not supported; HTTP/2 is untested and unsupported; there is no Workers target.
- No build: nonce-mode CSP only, caching opt-in through policies, no budgets.
- A literal colon (`::`) in a route registered before the plugin reads back from the router tree as a parameter.
- Verified locally: the package tests (including `@fastify/static`, `@fastify/compress`, `@fastify/etag`, `@fastify/formbody` and `@fastify/websocket`), `examples/fastify` with `hypdriv audit all` and `e2e-hosts check` on Node and as the Function `vercel build` produces, run in process with the handler-shape detection of Vercel's Node launcher. Live Vercel deployments remain pending (`docs/preview-status.md`).

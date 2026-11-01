---
"@hypdriv/core": patch
"@hypdriv/cache": patch
"@hypdriv/security": patch
"@hypdriv/hono": patch
---

WebSocket upgrades survive the pipeline: `withHeaders`, `withoutHeaders`, `cloneResponse` and the header-adding stages (security headers, rate-limit headers, edge cache decoration) rebuild a 101 response through the new `rebuildResponse()` / `isUpgradeResponse()`, keeping the socket on Workers (`webSocket` in the init) and handing the original response back where the runtime cannot construct a 101 (Node), instead of throwing a `RangeError`. Hono: the route manifest lists catch-all handlers that answer by themselves (`app.all('/proxy/*', (c) => …)`), maps a trailing wildcard to an optional catch-all so `/files/*` also matches `/files`, and takes `mounted: ['/legacy']` for `app.mount()` apps, which Hono registers like middleware.

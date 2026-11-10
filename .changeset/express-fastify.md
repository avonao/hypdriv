---
"@hypdriv/express": minor
"@hypdriv/fastify": minor
"@hypdriv/runtime": minor
"@hypdriv/core": minor
"@hypdriv/cli": minor
"create-hypdriv": minor
---

Express 5 and Fastify 5 hosts.

- `@hypdriv/express`: `useHypDriv(app, { config })` / `hypdriv({ config })` runs the Drivetrain around an Express 5 app on Node, Vercel Functions (zero-config Express) and Cloudflare Workers (`httpServerHandler()` from `cloudflare:node` with `nodejs_compat`, Durable Objects bound). What the app writes is captured as a streaming Web `Response` (no buffering, backpressure, `HEAD`/`204`/`304` bodiless) and the pipeline's response goes out on the socket; request bodies stay with the app's parsers; `res.locals.hypdrivNonce`, `nonce()`, `hyp()`, `flag()`, `geo()` below the middleware; static files skip the stages and keep the security header preset; `checkOrder()` reports routes registered before the middleware and `compression()` after it; the route manifest comes from the router stack (mount paths read from Express 5's compiled matchers; `routes` and `version` options); `expressFetch()` renders stale-while-revalidate refreshes through the app; `webHandler()` mounts Web-standard handlers.
- `@hypdriv/fastify`: `app.register(hypdriv, { config })` is an encapsulation-breaking plugin on `onRequest` / `onSend` for Node and Vercel Functions (zero-config Fastify serves the server `listen()` starts). Streamed payloads, lazy request bodies handed back to Fastify's parsers, `request.hypdrivNonce`, the static-file preset (`@fastify/static`), hijacked replies and WebSockets left to the app, stale-while-revalidate through `fastify.inject()`, a warning when `@fastify/compress` is registered first, the route manifest from `onRoute` plus the router tree for routes registered earlier (`app.hypdriv.manifest()`), `webRoute()`. Fastify does not run on Cloudflare Workers (its router compiles handlers with `new Function()`).
- `@hypdriv/runtime`: new `./node` entry with the Node ↔ Web bridge both hosts use (`bridgeRequest`, `NodeRequestBody`, `syncRequestHeaders`, `writeWebResponse`, `withAssetHeaders`, `appRequestHeaders`, `requestUrl`, `remoteAddress`). Documents rendered with a nonce are never answered `304` from validators the app computed: `appRequestHeaders()` drops conditional request headers from HTML navigations that carry a nonce.
- `@hypdriv/core`: `FrameworkName` gains `express` and `fastify` (labels `Express`, `Fastify`).
- `@hypdriv/cli`: detection (declared dependencies only; the entry that registers Hypdriv is reported), `hypdriv init` for both (Express: `useHypDriv()` after `const app = express()`, the `httpServerHandler()` Worker entry and wrangler settings on Cloudflare; Fastify: the plugin after `Fastify()`, Node by default, Workers refused), doctor checks `express.*` (integration, Express 5, registration, order, Vercel entry including extensionless ESM imports, Worker entry) and `fastify.*` (integration, Fastify 5, registration, `@fastify/compress` order, Vercel entry including a top-level `await` of `listen()`, Workers refused). The doctor's source masking now understands regular expression literals (a `/["']/` no longer hides a registration), and `hypdriv.manifest` does not ask Express or Fastify apps for a build.
- `create-hypdriv`: `--framework express` (Cloudflare, Vercel, Node) and `--framework fastify` (Vercel, Node; Node by default).

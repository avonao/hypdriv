# Hypdriv on Fastify

[Fastify](https://fastify.dev) is a fast, schema-first Node server framework with a plugin system and a request lifecycle of hooks. Hypdriv wraps a Fastify 5 app in the Drivetrain — the HTTPS upgrade, security headers, a CSP with a per-request nonce, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, structured logs, `Server-Timing` and the `/_hypdriv/*` routes — with one plugin, on Node and Vercel Functions.

Requirements: Fastify `>=5 <6`, Node 22.12+. Fastify does not run on Cloudflare Workers (see [Platforms](#platforms)).

## Setup

```sh
pnpm add @hypdriv/fastify @hypdriv/core
```

Add `hypdriv.config.ts` next to the server (see [configuration](./configuration.md)), then register the plugin:

```ts
// src/server.ts
import fastifyCompress from '@fastify/compress';
import { hypdriv } from '@hypdriv/fastify';
import Fastify from 'fastify';
import config from '../hypdriv.config.js';

const app = Fastify();
app.register(hypdriv, { config });   // the hooks cover every route, in every plugin context
app.register(fastifyCompress);       // after Hypdriv: it compresses the finished response
app.get('/', async () => 'hello');
app.listen({ port: 3000 });
```

`hypdriv init` does this for an existing server (it edits a one-line `const app = Fastify(…)` and prints the exact snippet for anything else), and `npm create hypdriv@latest -- --framework fastify` scaffolds a complete app (`examples/fastify`).

### Order

The plugin breaks encapsulation (it is wrapped with `fastify-plugin`), so its hooks apply to every route of the app, including routes registered before it and routes in nested plugins with a `prefix`. Order still matters for other plugins' `onSend` hooks, which run in registration order:

- **`@fastify/compress` belongs after the plugin.** Registered before it, it compresses the payload before the pipeline reads it, and a nonce cannot be injected into gzip. The plugin logs a warning when it finds `@fastify/compress` already registered (`app.hypdriv.warnings`), and `hypdriv doctor` (`fastify.order`) finds it in the source.
- **Plugins that read the payload as a string or buffer** (`@fastify/etag`) belong before the plugin: after it, they see the pipeline's response stream.

## What the plugin does

- **`onRequest` runs the stages before the app.** A rate limit, the bot shield, a redirect, maintenance mode, the HTTPS upgrade and the internal routes answer there, before routing. Otherwise the request continues to the route with the pipeline's request headers (client-sent `x-hypdriv-*` removed, the stages' own added) and `request.hypdrivNonce`.
- **`onSend` hands the reply to the stages after the app.** Whatever the route sent — a string, a buffer, JSON, a stream, `@fastify/static`'s file stream — becomes a streaming Web `Response`, runs through the CSP, the security headers, the nonce injection and the logs, and the final response is what Fastify sends, streaming. `HEAD`, `204` and `304` stay bodiless (Fastify's generated `HEAD` routes included).
- **The request body is read only when a stage asks for it** (CSRF, Turnstile) and goes back to Fastify's content-type parsers afterwards, so the JSON parser and `@fastify/formbody` read it as usual.
- **Static files skip the stages but get the security header preset** (`@fastify/static` responses for asset paths: `nosniff`, the frame and referrer policies, no `x-powered-by`); `staticHeaders: false` leaves them alone.
- **Documents rendered with a nonce are never answered `304` from validators the app computed** (`@fastify/etag`, `Last-Modified`): those describe the bytes before the nonce injection. Conditional headers are dropped from HTML navigations that carry a nonce; JSON and assets keep theirs.
- **Stale-while-revalidate renders through the app** with `fastify.inject()`, marked with a per-process token the Drivetrain recognises, because the request that served the stale copy is long finished.
- **Hijacked replies** (`reply.hijack()`, `@fastify/websocket` upgrades) never reach `onSend`: the stages before the app ran (rate limits, the bot shield, logs), the response phase settles with an empty stand-in and the app owns the socket.

## Using the request's facts

```ts
import { flag, geo, hyp, nonce } from '@hypdriv/fastify';

app.get('/', async (request, reply) =>
  reply.type('text/html').send(`<script nonce="${nonce()}">…</script>
    ${flag('newHero', false) ? '<h1>New</h1>' : '<h1>Old</h1>'} ${geo()?.country ?? ''}`),
);
```

`hyp()` returns the request context (id, route, geo, flags, theme, `waitUntil`, the environment); `nonce()` and `request.hypdrivNonce` are the request's CSP nonce. Any `<script>` the app renders without it gets the nonce from the streaming injection. `webRoute(jobHandler(...))` mounts a Web-standard handler (jobs, an auth library's `handler`) as a Fastify route.

## Platforms

| Platform | Entry | Notes |
| --- | --- | --- |
| Node | `app.listen({ port, host })` | The socket address is the client IP unless `security.trustedProxies` says the server sits behind proxies (then the forwarded headers decide). Behind a reverse proxy set `trustProxy` (or `HYPDRIV_TRUST_PROXY=1`) so the request URL takes `x-forwarded-proto` / `x-forwarded-host`. |
| Vercel | the module that calls `app.listen()` (zero-config Fastify) | Vercel deploys the first of `app`, `index`, `server` (at the root, then in `src/`) that imports `fastify` as one Function. A Fastify instance is not a request handler, so Vercel serves the server `listen()` starts: it captures the server in `listen()` and starts it after the module has loaded, which means **no top-level `await app.listen()`** (it would never finish). Relative imports need `.js` (each file is compiled to ESM as is). The Fastify preset does not publish `public/**` to the CDN: serve it with `@fastify/static` from `new URL('../public/', import.meta.url)`, which Vercel's file tracer includes in the Function. Leave `@fastify/compress` off (Vercel compresses at the edge). |
| Cloudflare Workers | — | **Not supported.** Fastify's router (`find-my-way`) compiles route handlers with `new Function()`, which workerd refuses ("Code generation from strings disallowed for this context"), and its plugin loader cannot finish in a Worker's global scope. Hypdriv does not fake it: `hypdriv init` and `create-hypdriv` refuse the platform, and `hypdriv doctor` fails `fastify.workers`. Use [Hono](./hono.md) for the Workers side. |

## The route manifest

Fastify has no build step, so there is no build manifest. The plugin collects every route the app registers with `onRoute` (full URL, prefixes of nested plugins included) and reads the routes registered before it back from the router's tree (`printRoutes()`); every route is a dynamic endpoint: `/users/:id` → `/users/[id]`, `/files/*` → `/files/[...splat]`, an optional last parameter `/docs/:page?` gives `/docs` and `/docs/[page]`, a regular expression on a parameter (`/:id(^\\d+)`) is ignored, and a segment with several parameters (`/range/:from-:to`) is named after the first (`/range/[from]`). Name routes the app adds by other means with `routes: ['/legacy/:id']`. `app.hypdriv.manifest()` returns the manifest as of now; `GET /_hypdriv/health` reports it; pass `manifest` to use a build-time one.

Consequences of "everything is rendered per request": the CSP is always in nonce mode, and edge caching is opt-in through `cache` policies in `hypdriv.config.ts`.

## Verify

```sh
pnpm hypdriv doctor                                   # fastify.*: integration, Fastify 5, registration, order, Vercel entry
pnpm hypdriv audit all --url http://localhost:3000    # A+ headers, CSP mode, cache behaviour
pnpm -F @hypdriv/e2e-hosts check --url http://localhost:3000 --framework fastify --dynamic / --api /api/time --rate-limit 60
```

`examples/fastify` passes the audit and the `e2e-hosts` check on Node (`tsx src/server.ts`) and as the Function `vercel build` produces, run in process with the handler-shape detection of Vercel's Node launcher (the captured `listen()` server).

## Limits

- Fastify 4 is not supported (`hypdriv doctor` fails `fastify.version`).
- No Cloudflare Workers (above).
- A literal colon in a route (`/a::b`) is printed by Fastify's router tree as a single `:`; a route with one, registered before the plugin, reads back as a parameter. Register the plugin first or name the route with `routes`.
- Hijacked replies and WebSocket connections get the request stages only (above).
- HTTP/2 (`http2: true`) is not supported (untested); terminate HTTP/2 at a proxy or the platform.
- Live Vercel deployments of this host are pending (`e2e/hosts`); the Node and Vercel-build runs above are local.

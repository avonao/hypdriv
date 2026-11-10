# Hypdriv on Express

[Express](https://expressjs.com) is the most widely deployed Node server framework. Hypdriv wraps an Express 5 app in the Drivetrain — the HTTPS upgrade, security headers, a CSP with a per-request nonce, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, structured logs, `Server-Timing` and the `/_hypdriv/*` routes — with one middleware, on Node, Vercel Functions and Cloudflare Workers.

Requirements: Express `>=5 <6` (Express 4 is not supported: the middleware relies on Express 5's router and response API), Node 22.12+.

## Setup

```sh
pnpm add @hypdriv/express @hypdriv/core
pnpm add @hypdriv/cloudflare   # Cloudflare only: the Durable Objects behind exact rate limits, tag purges and live channels
```

Add `hypdriv.config.ts` next to the app (see [configuration](./configuration.md)), then register the middleware **before the routes**:

```ts
// src/app.ts
import { useHypDriv } from '@hypdriv/express';
import express from 'express';
import config from '../hypdriv.config.js';

const app = express();
useHypDriv(app, { config });   // before routes, routers and static files: Express runs middleware in order
app.get('/', (req, res) => res.send('hello'));
export default app;
```

`hypdriv init` does this for an existing app (it edits a one-line `const app = express()` and prints the exact snippet for anything else, including CommonJS entries), and `npm create hypdriv@latest -- --framework express` scaffolds a complete app (`examples/express`).

### Order

Express runs middleware in registration order, so the order decides what the Drivetrain sees:

- **Routes, mounted routers and apps, `express.static` registered before `useHypDriv()`** answer without it: no security headers, rate limits or CSP. Register Hypdriv first.
- **`compression()` belongs before `useHypDriv()`.** It then compresses the pipeline's finished response; registered after it, it compresses the body before the pipeline reads it, and a nonce cannot be injected into gzip.

`useHypDriv()` logs both problems when the first request arrives (`checkOrder(app, middleware)` returns them), and `hypdriv doctor` (`express.order`) finds them in the source.

## What the middleware does

- **The response is streamed through the pipeline.** What the app writes (`res.write`, `res.send`, `res.sendFile`, `res.json`, server-sent events, a view engine) is captured as a streaming Web `Response`, runs through the stages after the app (CSP, security headers, the nonce injection, logs) and goes out on the socket chunk by chunk, with backpressure. `HEAD`, `204` and `304` stay bodiless.
- **The request body stays with the app.** It is read lazily: a stage that inspects a form field (CSRF, Turnstile) reads what it needs, and the body parsers registered after the middleware still read the full body.
- **Client-sent `x-hypdriv-*` headers are removed** before the stages run; the app sees the stages' own headers (`x-hypdriv-route`, …) in `req.headers`.
- **Static files skip the stages but get the security header preset.** Requests for asset paths (`.css`, `.js`, images, fonts…) go straight to the app (`express.static`, `res.sendFile`) and leave with `nosniff`, the frame and referrer policies and without `x-powered-by`; `staticHeaders: false` leaves them alone, `skip` changes the rule.
- **Documents rendered with a nonce are never answered `304` from validators the app computed.** Express's `ETag` (and any `Last-Modified`) describe the bytes before the nonce injection, which are the same on every request; a `304` would make the browser reuse a page with an earlier nonce. The middleware drops `If-None-Match`, `If-Modified-Since` and friends from HTML navigations that carry a nonce; JSON, assets and other requests keep their conditional requests.
- **Stale-while-revalidate renders through the app.** The background revalidation of a stale cache entry runs a synthetic request through the app (`expressFetch()`), because the request that served the stale copy is long finished.

## Using the request's facts

```ts
import { flag, geo, hyp, nonce } from '@hypdriv/express';

app.get('/', (req, res) => {
  res.send(`<script nonce="${nonce()}">…</script>
    ${flag('newHero', false) ? '<h1>New</h1>' : '<h1>Old</h1>'} ${geo()?.country ?? ''}`);
});
```

`hyp()` returns the request context (id, route, geo, flags, theme, `waitUntil`, the environment); `nonce()` and `res.locals.hypdrivNonce` (for view engines) are the request's CSP nonce. Any `<script>` the app renders without it gets the nonce from the streaming injection, so a missing attribute never breaks a page. `webHandler(jobHandler(...))` mounts a Web-standard handler (jobs, an auth library's `handler`) as an Express route.

## Platforms

| Platform | Entry | Notes |
| --- | --- | --- |
| Node | `app.listen(port)`, with `compression()` before the middleware | The socket address is the client IP unless `security.trustedProxies` says the server sits behind proxies (then the forwarded headers decide). Behind a reverse proxy set `trustProxy` (or `HYPDRIV_TRUST_PROXY=1`) so the request URL takes `x-forwarded-proto` / `x-forwarded-host`. |
| Vercel | `export default app` (zero-config Express) | Vercel deploys the first of `app`, `index`, `server` (at the root, then in `src/`) that imports `express` as one Function on Fluid compute; the module must `export default app` or call `app.listen()`. Vercel compiles each file to ESM without rewriting import specifiers, so relative imports need `.js` (`./app.js`). `express.static` is ignored: Vercel serves `public/**` from its CDN. The Vercel stage applies page cache policies (`Vercel-CDN-Cache-Control`, cache tags); the forwarded headers give the client IP. |
| Cloudflare Workers | `httpServerHandler({ port })` from `cloudflare:node` around `app.listen(port)`, plus the Durable Object re-exports | `compatibility_flags: ["nodejs_compat"]`. workerd's Node HTTP server hands each request to the app; bindings and `waitUntil` come from `cloudflare:workers`, so the Durable Objects give exact rate limits, tag purges and live channels. Leave `compression()` out (the request a Worker sees advertises `br, gzip` whatever the client sent, and Cloudflare compresses at the edge) and serve static files with Workers Static Assets. |

```ts
// src/worker.ts — the wrangler `main`
import { httpServerHandler } from 'cloudflare:node';
import app from './app.js';
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

app.listen(8080);
export default httpServerHandler({ port: 8080 });
```

`examples/express` has all three entries: `src/app.ts` (the app, Vercel's entry), `src/server.ts` (Node: `compression()` and `express.static` around the app) and `src/worker.ts` with `wrangler.jsonc`.

## The route manifest

Express has no build step, so there is no build manifest. `useHypDriv()` derives one from the app's router stack when the first request arrives: every route is a dynamic endpoint (`/users/:id` → `/users/[id]`, `/files/*path` → `/files/[...path]`, an optional group `/book{/:chapter}` gives `/book` and `/book/[chapter]`), routers mounted with `app.use('/api', router)` contribute their routes under the mount path (Express 5 keeps a mount path only inside a compiled `path-to-regexp` matcher; Hypdriv runs each matcher once, synchronously, and reads the expression it uses back as a pattern), and a mounted sub-app appears as `/<mount>/[[...splat]]`. Regular-expression routes cannot be expressed as patterns and are left out; name them with `routes: ['/legacy/[id]']`. `GET /_hypdriv/health` reports the manifest; pass `manifest` to use a build-time one, and `version` to name the Express version where `express/package.json` is not readable at run time (a Worker, a traced Vercel Function: the health route then says `Express unknown`).

Consequences of "everything is rendered per request": the CSP is always in nonce mode (there are no static documents to hash), and edge caching is opt-in through `cache` policies in `hypdriv.config.ts`.

## Verify

```sh
pnpm hypdriv doctor                                   # express.*: integration, Express 5, registration, order, platform entry
pnpm hypdriv audit all --url http://localhost:3000    # A+ headers, CSP mode, cache behaviour
pnpm -F @hypdriv/e2e-hosts check --url http://localhost:3000 --framework express --dynamic / --api /api/time --rate-limit 60
```

`examples/express` passes the audit and the `e2e-hosts` check on Node (`tsx src/server.ts`), on workerd (`wrangler dev`, with the Durable Objects bound) and as the Function `vercel build` produces, run in process the way Vercel's Node launcher calls it.

## Limits

- Express 4 is not supported (`hypdriv doctor` fails `express.version`).
- A sub-app mounted with `app.use('/admin', adminApp)` is opaque to the parent's router: it is one `/admin/[[...splat]]` entry in the manifest. Register `useHypDriv()` on the app that owns the routes.
- A mount path that is a regular expression (or holds a custom regexp parameter) cannot be read back: the routes below it are left out of the manifest rather than guessed. Name them with `routes`.
- WebSocket upgrades (`ws`, `socket.io`) bypass Express middleware entirely: they are handled on the server's `upgrade` event and never reach the Drivetrain.
- HTTP/2 (`http2.createSecureServer`) is not supported (untested); terminate HTTP/2 at a proxy or the platform.
- `express.static` does not run on Vercel (the CDN serves `public/**`) or Workers (use Workers Static Assets); there the static layer answers before the app, so `forceHttps` relies on the platform's HTTPS redirect for those files.
- Live Cloudflare and Vercel deployments of this host are pending (`e2e/hosts`); the Node, workerd and Vercel-build runs above are local.

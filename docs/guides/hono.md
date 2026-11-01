# Hypdriv on Hono

[Hono](https://hono.dev) is a small, Web-standards server framework that runs unchanged on Cloudflare Workers, Vercel Functions, Node, Bun and Deno. Hypdriv wraps it in the Drivetrain — the HTTPS upgrade, security headers, a CSP with a per-request nonce, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, structured logs, `Server-Timing` and the `/_hypdriv/*` routes — with one line.

Requirements: Hono `>=4.6 <5`, Node 22.12+ (the package itself is runtime neutral; Workers, Bun and Deno need no Node).

## Setup

```sh
pnpm add @hypdriv/hono @hypdriv/core
pnpm add @hypdriv/cloudflare   # Cloudflare only: the Durable Objects behind exact rate limits and tag purges
```

Add `hypdriv.config.ts` next to the entry (see [configuration](./configuration.md)), then register the middleware **first**:

```ts
// src/app.ts
import { useHypDriv } from '@hypdriv/hono';
import { Hono } from 'hono';
import config from '../hypdriv.config';

const app = new Hono();
useHypDriv(app, { config });          // before every route: Hono middleware only wraps what is registered after it
app.get('/', (c) => c.text('hello'));
export default app;
```

`hypdriv init` does this for an existing app (it edits a one-line `const app = new Hono()` and prints the exact snippet for anything else), and `npm create hypdriv@latest -- --framework hono` scaffolds a complete app (`examples/hono`).

### Around the whole app

`useHypDriv()` is middleware, so it cannot change the request the app sees. `wrapHono()` wraps the app's `fetch` instead and forwards the pipeline's request (sanitised headers, the stages' `x-hypdriv-*` headers). The result has the app's `fetch` signature:

```ts
import { wrapHono } from '@hypdriv/hono';
export default wrapHono(app, { config });   // a Worker, Bun.serve, Deno.serve; serve({ fetch: wrapped.fetch }) on Node
```

Both forms produce the same response for the pipeline-managed headers (tested). Use the wrapper when you want the order of your routes not to matter; `hypdriv doctor` (`hono.order`) fails when a route is registered before the middleware.

## Platforms

| Platform | Entry | Notes |
| --- | --- | --- |
| Cloudflare Workers | `export default app` (or the wrapper) plus `export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects'` | Bindings come from `c.env`, `waitUntil` from `c.executionCtx`. Durable Objects give exact rate limits, tag purges and live channels; without them the memory/Cache API tier applies. `compatibility_flags: ["nodejs_compat"]`. |
| Vercel | `export default app` from `src/index.ts` (zero-config Hono) | The Vercel stage applies page cache policies; `waitUntil` comes from Vercel's request context. |
| Node | `serve({ fetch: app.fetch })` from `@hono/node-server` | The socket address is the client IP unless `security.trustedProxies` says the server sits behind proxies (then the forwarded headers decide). |
| Bun, Deno | `Bun.serve({ fetch })`, `Deno.serve(handler)` | Forwarded headers decide the client IP; set `security.trustedProxies` to match your proxy chain. |

## Using the request's facts

```tsx
import { flag, geo, hyp, nonce } from '@hypdriv/hono';

app.get('/', (c) =>
  c.html(
    <html>
      <head><script nonce={nonce()}>{'…'}</script></head>
      <body>{flag('newHero', false) ? <Hero /> : <OldHero />} {geo()?.country}</body>
    </html>,
  ),
);
```

`hyp()` returns the request context (id, route, geo, flags, theme, `waitUntil`, the environment); `nonce()` and `c.get('hypdrivNonce')` (type `HypDrivHonoVariables`) are the request's CSP nonce. Any `<script>` the app renders without it gets the nonce from the portable streaming injection, so a missing attribute never breaks a page.

## The route manifest

Hono has no build step, so there is no build manifest. `useHypDriv()` and `wrapHono()` derive one from `app.routes` when the first request arrives: every route is a dynamic endpoint (`/users/:id` → `/users/[id]`, `/files/*` → `/files/[...splat]`, `:lang?` → `[[lang]]`), middleware registrations are skipped. The manifest gives route ids to rate limits, cache policies, flags and logs; `GET /_hypdriv/health` reports it. Pass `manifest` to use a build-time manifest instead.

Consequences of "everything is rendered per request": the CSP is always in nonce mode (there are no static documents to hash), and edge caching is opt-in through `cache` policies in `hypdriv.config.ts`.

## Verify

```sh
pnpm hypdriv doctor                              # integration installed, registered, middleware order
pnpm hypdriv audit all --url http://localhost:3000   # A+ headers, CSP mode, cache behaviour
```

`examples/hono` passes the audit on Node (`@hono/node-server`) and on workerd (`wrangler dev`).

## Limits

- `useHypDriv()` cannot rewrite the request the app receives (a Hono middleware can only replace the response); use `wrapHono()` when a stage must.
- Static files served by `hono/serve-static` pass through the pipeline like any route; on Workers Static Assets answer before the Worker, so the zone's HTTPS redirect (not Hypdriv's `forceHttps`) covers plain-HTTP asset requests ([ADR 0019](../adr/0019-vite-hosts.md), item 11).
- Live Cloudflare and Vercel runs of this host are pending (`e2e/hosts`); the Node and workerd runs are in the test suite and the example audit.

Design decisions: [ADR 0020](../adr/0020-hono-host.md).

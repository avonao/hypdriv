# Nuxt

`@hypdriv/nuxt` is a Nuxt module. It runs the Hypdriv Drivetrain around every Nitro response — security headers, CSP (nonces for rendered pages, hashes for prerendered ones), rate limiting, the bot shield, geo, feature flags, i18n, redirects, maintenance mode, Early Hints, logging, tracing and Server-Timing, and the `/_hypdriv/*` routes — and it writes the build manifest and the platform's static headers. It targets **Nuxt 4.6+ on Nitro 2** (h3 1.x) with the `cloudflare-module`, `vercel` and `node-server` presets; the other Cloudflare and Node presets work with the in-app hook described below.

## Setup

```sh
pnpm add @hypdriv/nuxt @hypdriv/core
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@hypdriv/nuxt'],
  // All optional:
  hypdriv: {
    // config: './hypdriv.config.ts',   // default: hypdriv.config.* in the project root
    // dev: true,                        // run the pipeline in `nuxt dev`
    // nonce: true,                      // Nuxt stamps the CSP nonce on the tags it renders
    // staticHeaders: true,              // _headers / Build Output header routes
    // cloudflare: { worker: true, exports: '~~/server/worker-exports' },
  },
});
```

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
  flags: { definitions: { newHero: { default: false, rules: [{ when: { country: ['US'] }, value: true }] } } },
});
```

`examples/nuxt` is a complete app (a prerendered page, a per-request page showing `hyp()` facts, API routes) that builds for all three platforms: `HYPDRIV_TARGET=cloudflare|vercel|node nuxt build` (default: `vercel` when `VERCEL=1`, else `cloudflare`).

### Cloudflare Workers

Use the `cloudflare-module` preset. Let Nitro write the Worker configuration from your `wrangler.jsonc` (it adds `main` and the assets directory):

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@hypdriv/nuxt'],
  nitro: { preset: 'cloudflare-module', cloudflare: { deployConfig: true } },
});
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" },
      { "name": "HYPDRIV_INDEX", "class_name": "HypDrivIndex" },
      { "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }
    ]
  },
  "migrations": [
    { "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }
  ]
}
```

`nuxt build`, then `wrangler dev` / `wrangler deploy` from the project (Nitro points them at `.output/server/wrangler.json`). The Durable Objects are optional upgrades: without the bindings, rate limits count per isolate and tag purges are TTL-bounded.

The module replaces the preset's Worker entry with Hypdriv's: the Worker shell (`createWorker({ app })` from `@hypdriv/cloudflare`) around Nitro. The pipeline therefore runs on a true Web `Request`/`Response` at the edge — with `HTMLRewriter` nonce injection, the edge cache and the edge-only stages — and the Nitro hook inside passes through. The entry also

- exports `HypDrivChannel`, `HypDrivIndex` and `HypDrivLimiter`, plus every named export of `cloudflare.exports` (your own Durable Objects, Workflows, `WorkerEntrypoint`s);
- runs cron triggers through Hypdriv's jobs (`jobs.cron`, `cache.warm`) **and** Nitro's `cloudflare:scheduled` hooks and scheduled tasks;
- sends queue batches and email to Hypdriv when `jobs.queues` / `jobs.email` configure a consumer, otherwise to Nitro's `cloudflare:queue` / `cloudflare:email` hooks;
- serves build assets from Workers Static Assets, and prerendered pages that reach the Worker (`assets.run_worker_first`) from the assets too, instead of re-rendering them.

Set `hypdriv.cloudflare.worker: false` to keep Nitro's own entry; the in-app hook then runs the pipeline (`runner: host`, portable nonce injection). `cloudflare-pages` and `cloudflare-durable` always use the in-app hook.

### Vercel

Use the `vercel` preset (Vercel's build sets it automatically). The pipeline runs inside the Nitro function (`runner: host`), so it owns the response: nonces are injected, Vercel CDN headers follow the route's policy, `waitUntil` comes from Vercel's request context. After the build the module inserts Hypdriv's header routes (security headers, the hash CSP and Early Hints of each prerendered page) into `.vercel/output/config.json` ahead of `handle: filesystem`, and writes the final manifest into the function. Deploy with `vercel deploy --prebuilt` or Git integration as usual.

### Node

Use `node-server` and start `node .output/server/index.mjs`. Every request except build assets (`/_nuxt/*`) and media files goes through the pipeline — prerendered pages included, since Nitro serves them. Without `security.trustedProxies`, the client IP is the socket address; behind a proxy set `trustedProxies` so the pipeline reads `x-forwarded-for`.

## What runs where

| | Cloudflare (`cloudflare-module`) | Vercel | Node |
|---|---|---|---|
| Rendered pages, API routes, Nuxt error pages | Hypdriv Worker shell around Nitro (`runner: worker`) | Nitro hook in the function (`runner: host`) | Nitro hook (`runner: host`) |
| Prerendered pages | the shell with `run_worker_first`, served from the assets binding (without it: Workers Static Assets + `_headers`) | Vercel CDN + `config.json` header routes + Hypdriv's Routing Middleware | Nitro hook |
| `/_nuxt/*` build assets | Workers Static Assets (Nitro's immutable caching) | Vercel CDN | Nitro, without the pipeline |
| `scheduled` / `queue` / `email` | Hypdriv jobs + Nitro hooks | Vercel Cron → `jobHandler` routes | — |
| `nuxt dev` | Nitro hook (`runner: host`, development mode) | | |

The Nitro hook wraps Nitro's h3 app handler — the one function every request of every preset passes through. The request stages run first; a short-circuit (rate limit, bot block, redirect, maintenance, `/_hypdriv/*`) answers without rendering. Otherwise Nitro renders into a capture response inside the request's `AsyncLocalStorage` context, the response stages post-process the captured head and streaming body, and the result goes to the client. Errors are rendered by Nitro's error handler — Nuxt's error page — inside the same capture, so 404 and 500 responses get the full pipeline too. Requests the application makes to itself (`$fetch('/api/…')` during rendering, Nuxt's error-page sub-request) pass through: they belong to the outer request. While Nuxt prerenders, the hook is not installed at all (`import.meta.prerender` is a build-time constant, so no production bundle contains a bypass).

The pipeline may read the request body (CSRF form tokens, Turnstile): it reads it through h3's body cache, so `readBody(event)` in your routes still works.

## Request context

Server code (API routes, server middleware, utilities):

```ts
// server/api/whoami.get.ts
import { flag, hyp } from '@hypdriv/nuxt/server';
import { defineEventHandler } from 'nuxt/server';

export default defineEventHandler(() => ({
  requestId: hyp()?.requestId,
  country: hyp()?.country,
  newHero: flag('newHero', false),
}));
```

`@hypdriv/nuxt/server` exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler`. Components use the auto-imported composables:

- `useHyp()` — request id, runner, matched route, country, locale, CSP mode and the public flags (`serverOnly` flags filtered out), rendered on the server and hydrated from the payload.
- `useHypNonce()` — the request's nonce during server rendering (`undefined` on the client), for markup Nuxt does not render through unhead. Keep it out of the payload.

Signed jobs (Cloudflare cron/queue dispatch, Vercel Cron, `hypdriv jobs run`):

```ts
// server/api/jobs/digest.post.ts
import { jobHandler } from '@hypdriv/nuxt/server';
import { defineEventHandler } from 'nuxt/server';

const handle = jobHandler({}, async ({ job, payload }) => ({ sent: true, job, payload }));
export default defineEventHandler((event) => handle(event.req));
```

## CSP

- **Rendered pages** use nonce mode. The module hands the request's nonce to Nuxt, whose server plugin stamps it on every `<script>`, `<style>` and script/style `<link>` unhead renders — the import map, the `__NUXT__` config, the payload, `useHead` scripts, and in streaming mode the bootstrap and suspense chunks. The pipeline then injects the same nonce into anything else (idempotently): HTMLRewriter on Cloudflare, the portable streaming injector on Node and Vercel. In `nuxt dev` the plugin also renders the `csp-nonce` meta tag Vite's client reads, and the policy allows the HMR socket.
- **Prerendered pages** use hash mode: the build hashes their inline scripts, and the platform sends the policy from `_headers` / `config.json` (Node: the pipeline, at run time).
- **Renders Nitro caches** (`cache` / `swr` route rules) never get a nonce stamped: the cached document would carry one request's nonce. The pipeline injects the current request's nonce into the cached HTML instead.
- **Your own policy wins**: if a route sets `Content-Security-Policy` itself (for example with `nuxt-security`), Hypdriv keeps it and reports `x-hypdriv-csp: app`.

## Build output

`nuxt build` writes `.hypdriv/manifest.json` (pages and server routes with their classification, client assets per page, CSP hashes and Early Hints of prerendered pages, budgets, the secrets scan) and fails when the manifest checks fail. Pages come from Nuxt's router (`pages:resolved`), server routes from Nitro's handlers, prerendered documents from Nitro's prerenderer, client assets from Nuxt's client manifest. The server bundle embeds the final manifest; after Nitro wrote the output the module verifies (and if needed rewrites) it in every server file, then writes the static header rules for the platform. Build-asset caching stays Nitro's: its `publicAssets` rules already mark `/_nuxt/*` immutable on every platform.

## Limitations

- Nuxt 5 (Nitro 3, h3 2) is not supported yet; the module refuses to load on Nitro 3.
- Nitro 2 buffers responses on Cloudflare (`localFetch`): streaming SSR and event streams arrive in one piece there. Node and Vercel stream.
- WebSocket upgrades (`nitro.experimental.websocket`) go to Nitro directly on Cloudflare, without the pipeline.
- Prerendered pages get the request stages on both edge platforms: on Cloudflare route them through the Worker with `assets.run_worker_first` (the example uses `["/*", "!/_nuxt/*"]`; the Worker entry serves them from the assets binding with their build-time hash CSP), on Vercel Hypdriv's Routing Middleware runs for exactly those pages (`hypdriv: { vercel: { middleware: false } }` turns it off). Without either they carry their static headers only.
- Cloudflare's `_headers` holds at most 100 rules; documents beyond that are reported at build time and still get their CSP from the Worker when it serves them.
- The pipeline asks Nitro for identity-encoded responses (it may rewrite the body); compression is the CDN's or the reverse proxy's job.
- Facts rendered into a page that Nitro caches (`useHyp()` in a `swr` route) are those of the request that filled the cache.

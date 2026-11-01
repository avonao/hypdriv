# Nitro

`@hypdriv/nitro` is a Nitro module. It runs the Hypdriv Drivetrain around every Nitro response — security headers, CSP (nonces for rendered pages, hashes for prerendered ones), rate limiting, the bot shield, geo, feature flags, i18n, redirects, maintenance mode, Early Hints, logging, tracing and Server-Timing, and the `/_hypdriv/*` routes — and it writes the build manifest and the platform's static headers. One module covers **Nitro 2** (`nitropack` 2.12+, h3 1.x) and **Nitro 3** (`nitro` 3.0 release candidates, h3 2) with the `cloudflare-module`, `vercel` and `node-server` presets. [Analog](analog.md) is built on it; Nuxt has its own module ([Nuxt](nuxt.md)).

## Setup

```sh
pnpm add @hypdriv/nitro @hypdriv/core
```

**Nitro 2, or Nitro 3 without Vite** — a module in `nitro.config.ts`:

```ts
// nitro.config.ts
import { hypdrivNitro } from '@hypdriv/nitro';
import { defineNitroConfig } from 'nitropack/config';

export default defineNitroConfig({
  modules: [hypdrivNitro()],
  // All options are optional (see "Options"):
  // modules: [hypdrivNitro({ config: './hypdriv.config.ts', dev: true, staticHeaders: true })],
});
```

**Nitro 3 with Vite (`nitro/vite`)** — a Vite plugin; `nitro()` registers any plugin that carries a `nitro` key as a Nitro module:

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/nitro/vite';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [nitro({ serverDir: 'server' }), hypdriv()] });
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

`hypdriv init` detects Nitro 2 and Nitro 3 (and Nitro 3 on Vite) and makes these edits; `hypdriv doctor` checks them.

`examples/nitro` (Nitro 2) and `examples/nitro-vite` (Nitro 3 on Vite) are complete apps — two prerendered pages, a per-request page showing `hyp()` facts, API routes, a content-hashed asset — that build for all three platforms: `HYPDRIV_TARGET=cloudflare|vercel|node` (default: `vercel` when `VERCEL=1`, else `cloudflare`). `create-hypdriv --framework nitro` scaffolds the Nitro 2 one.

### Cloudflare Workers

Use the `cloudflare-module` preset and let Nitro write the Worker configuration from your `wrangler.jsonc` (it adds `main` and the assets directory):

```ts
// nitro.config.ts
export default defineNitroConfig({
  modules: [hypdrivNitro()],
  preset: 'cloudflare-module',
  cloudflare: { deployConfig: true },
});
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  // Prerendered pages live at `about/index.html`: serve them at `/about` without a redirect. The Worker runs first
  // for everything except content-hashed assets, so prerendered pages get the request stages too.
  "assets": { "html_handling": "drop-trailing-slash", "run_worker_first": ["/*", "!/assets/*"] },
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

Build, then `wrangler dev` / `wrangler deploy` from the project (Nitro points them at `.output/server/wrangler.json`). The Durable Objects are optional upgrades: without the bindings, rate limits count per isolate and tag purges are TTL-bounded.

The module replaces the preset's Worker entry with Hypdriv's: the Worker shell (`createWorker({ app })` from `@hypdriv/cloudflare`) around Nitro. The pipeline therefore runs on a true Web `Request`/`Response` at the edge — with `HTMLRewriter` nonce injection, the edge cache and the edge-only stages — and the Nitro hook inside passes through. The entry also

- exports `HypDrivChannel`, `HypDrivIndex` and `HypDrivLimiter`, plus every named export of `cloudflare.exports` (your own Durable Objects, Workflows, `WorkerEntrypoint`s);
- runs cron triggers through Hypdriv's jobs (`jobs.cron`, `cache.warm`) **and** Nitro's `cloudflare:scheduled` hooks and scheduled tasks;
- sends queue batches and email to Hypdriv when `jobs.queues` / `jobs.email` configure a consumer, otherwise to Nitro's `cloudflare:queue` / `cloudflare:email` hooks;
- serves build assets from Workers Static Assets, and prerendered pages that reach the Worker (`assets.run_worker_first`) from the assets too, instead of re-rendering them.

Set `cloudflare: { worker: false }` in the module options to keep Nitro's own entry; the in-app hook then runs the pipeline (`runner: host`, portable nonce injection). `cloudflare-pages` and `cloudflare-durable` always use the in-app hook.

Nitro 3's development server (`vite dev` or `nitro dev`) with this preset runs the Worker in miniflare with the bindings of `wrangler.jsonc`; the module exports the Hypdriv Durable Objects from that development Worker too, so rate limits and tag purges behave as in production.

### Vercel

Use the `vercel` preset (Vercel's build sets it automatically). The pipeline runs inside the Nitro function (`runner: host`), so it owns the response: nonces are injected, Vercel CDN headers follow the route's policy, `waitUntil` comes from Vercel's request context. After the build the module inserts Hypdriv's header routes (security headers, the hash CSP and Early Hints of each prerendered page) into `.vercel/output/config.json` ahead of `handle: filesystem`, adds a Routing Middleware so the request stages also run for the prerendered pages the CDN would otherwise answer on its own, and writes the final manifest into the function. Deploy with `vercel deploy --prebuilt` or Git integration as usual.

### Node

Use `node-server` and start `node .output/server/index.mjs`. Every request except immutable build assets (`/assets/*` by default) goes through the pipeline — prerendered pages included, since Nitro serves them. Without `security.trustedProxies`, the client IP is the socket address; behind a proxy set `trustedProxies` so the pipeline reads `x-forwarded-for`.

## What runs where

| | Cloudflare (`cloudflare-module`) | Vercel | Node |
|---|---|---|---|
| Rendered pages, API routes, error pages | Hypdriv Worker shell around Nitro (`runner: worker`) | Nitro hook in the function (`runner: host`) | Nitro hook (`runner: host`) |
| Prerendered pages | the shell with `run_worker_first`, served from the assets binding (without it: Workers Static Assets + `_headers`) | Vercel CDN + `config.json` header routes + Hypdriv's Routing Middleware | Nitro hook |
| Content-hashed assets (`assetPrefixes`) | Workers Static Assets | Vercel CDN | Nitro, without the pipeline |
| `scheduled` / `queue` / `email` | Hypdriv jobs + Nitro hooks | Vercel Cron → `jobHandler` routes | — |
| Development server | Nitro hook (`runner: host`, development mode) | | |

The Nitro hook wraps the one function every request of every preset passes through (Nitro 2: the h3 app handler; Nitro 3: `nitroApp.fetch`). The request stages run first; a short-circuit (rate limit, bot block, redirect, maintenance, `/_hypdriv/*`) answers without rendering. Otherwise Nitro renders into a capture response inside the request's `AsyncLocalStorage` context, the response stages post-process the captured head and streaming body, and the result goes to the client. Errors are rendered by Nitro's error handler inside the same capture, so 404 and 500 responses get the full pipeline too. Nitro's own prerender instance is not wrapped (the module installs only the runtime there), so prerendered files carry no request's nonce.

The pipeline may read the request body (CSRF form tokens, Turnstile): it reads it through the framework's body cache, so `readBody(event)` (Nitro 2) or `event.req.json()` (Nitro 3) in your routes still works.

## Request context

Server code (routes, middleware, utilities):

```ts
// server/api/whoami.get.ts
import { flag, hyp } from '@hypdriv/nitro/server';

export default defineEventHandler(() => ({
  requestId: hyp()?.requestId,
  country: hyp()?.country,
  newHero: flag('newHero', false),
}));
```

`@hypdriv/nitro/server` exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler`. `hyp()` returns `null` outside a request (the build-time prerender). On Nitro 2 the same facts are on `event.context.hypdriv`; the request's nonce is also the `x-nonce` request header (`nonce: false` turns both off).

Signed jobs (Cloudflare cron/queue dispatch, Vercel Cron, `hypdriv jobs run`):

```ts
// server/api/jobs/digest.post.ts
import { jobHandler } from '@hypdriv/nitro/server';

const handle = jobHandler({}, async ({ job, payload }) => ({ sent: true, job, payload }));

// Nitro 3 (h3 2): the event carries a Web Request.
export default defineHandler((event) => handle(event.req));
// Nitro 2 (h3 1): import { toWebRequest } from 'h3';
//   export default defineEventHandler((event) => handle(toWebRequest(event)));
```

## CSP

- **Rendered pages** use nonce mode: stamp `nonce()` on the inline `<script>` and `<style>` you render (see `examples/nitro/server/utils/page.ts`). The pipeline then injects the same nonce into anything else that carries none, idempotently: HTMLRewriter on Cloudflare, the portable streaming injector on Node and Vercel.
- **Prerendered pages** use hash mode: the build hashes their inline scripts and styles, and the platform sends the policy from `_headers` / `config.json` (Node: the pipeline, at run time). `nonce()` is `undefined` while Nitro prerenders, so one template serves both modes.
- **Renders Nitro caches** (`cache` / `swr` route rules) never get a nonce stamped by the application: the cached document would carry one request's nonce. The pipeline injects the current request's nonce into the cached HTML instead.
- **Your own policy wins**: if a route sets `Content-Security-Policy` itself, Hypdriv keeps it and reports `x-hypdriv-csp: app`.

## Build output

The build writes `.hypdriv/manifest.json` (pages and server routes with their classification, client assets per page, CSP hashes and Early Hints of prerendered pages, budgets, the secrets scan) and fails when the manifest checks fail. Routes come from Nitro's handlers (a handler is a page when Nitro's `renderer` serves it or the host says so, otherwise an endpoint); prerendered documents from Nitro's prerenderer; client assets from the Vite client build's manifest when there is one. The server bundle embeds the final manifest; after Nitro wrote the output the module verifies (and if needed rewrites) it in every server file, then writes the static header rules for the platform and removes the Vite build metadata (`.vite/`) from the public output.

Hashed build assets (default prefix `/assets/`, option `assetPrefixes`) are answered without the pipeline. With an explicit `assetPrefixes` the module also gives them `cache-control: public, max-age=31536000, immutable` as a Nitro route rule (`immutableAssets` forces it on or off); a prefix that already has a `cache-control` rule keeps it. For plain Nitro give the directory a `publicAssets` entry with `maxAge`, as `examples/nitro` does.

## Options

| Option | Default | |
|---|---|---|
| `config` | `hypdriv.config.*` in the root | Config file path or inline config |
| `root` | Nitro's `rootDir` | Project root |
| `dev` | `true` | Run the pipeline in the development server |
| `nonce` | `true` | Hand the CSP nonce to the application |
| `staticHeaders` | `true` | Write `_headers` / `config.json` header routes |
| `vercel.middleware` | `true` | Routing Middleware for prerendered pages on Vercel |
| `cloudflare.worker` | `true` | Use Hypdriv's Worker entry for `cloudflare-module` |
| `cloudflare.exports` | — | Module whose named exports the Worker entry re-exports (your Durable Objects, Workflows…) |
| `assetPrefixes` | `['/assets/']` | Immutable build-asset prefixes answered without the pipeline |
| `immutableAssets` | on with explicit `assetPrefixes` | Immutable `cache-control` route rules for those prefixes |

Framework hosts add `framework`, `routes`, `isPage`, `internalPages`, `pageAssets` and `clientManifest` (see `HypdrivNitroOptions`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `hypdriv doctor` reports `nitro.cloudflare-preset` | The build uses `cloudflare-pages` or another preset, or no preset is set for the Cloudflare build | Set `preset: 'cloudflare-module'` and `cloudflare: { deployConfig: true }` (or `NITRO_PRESET=cloudflare-module`). Hypdriv's Worker shell wraps `cloudflare-module` only. |
| Pages answer, but no Hypdriv headers or rate limits on Cloudflare | `assets.run_worker_first` is missing: Workers Static Assets answer prerendered pages before the Worker | `"run_worker_first": ["/*", "!/assets/*"]` in `wrangler.jsonc`; without it prerendered pages carry their static `_headers` only |
| `Rolldown failed to resolve import "@hypdriv/cloudflare/durable-objects"` (Nitro 3) | An old `@hypdriv/nitro` imported the Durable Objects by bare specifier from a virtual module | Update `@hypdriv/nitro`; the module imports the file it resolves itself |
| Nitro 3 dev: `"HypDrivLimiter" is declared as a DurableObject but not exported` | Old module without the miniflare dev exports | Update `@hypdriv/nitro` |
| No `hypdriv:` lines in the build log | The build runs Nitro at log level 0 (frameworks such as Analog do) | Warnings still reach `console.warn`; info lines are shown at Nitro's default level |
| `/.vite/manifest.json` is publicly served | An old `@hypdriv/nitro` left the client build's metadata in the public output | Update; the module removes `.vite/` after the build reads it, and `.assetsignore` lists it on Cloudflare |
| Hashed files are not `immutable` | Nitro 2 `publicAssets` entry without `maxAge`, or a framework that sets none | Add `maxAge` (plain Nitro) or `assetPrefixes: ['/assets/']` (Hypdriv adds the route rule) |
| `html()` shows escaped markup (Nitro 3) | h3 2 escapes plain strings passed to `html()` | Wrap trusted markup with `raw()` from `nitro/h3` |
| Prerendered pages show `x-hypdriv-csp: hash` but a script is blocked | The page loads a script the build never saw (injected by a plugin at run time) | Allow its origin with `security.csp.allow.scripts` in `hypdriv.config.ts`, or render it at build time |
| Vite imports such as `?assets=client` fail while prerendering (Nitro 3) | Nitro 3 builds its prerender instance with plain Rolldown, without your Vite plugins | Keep server routes free of Vite-only imports, or render the pages through a Vite SSR service (`renderer`) |

## Limitations

- Nitro 3 is a release candidate (`3.0.261029-rc` at the time of writing); the module's Nitro 3 hooks (`vite:compile:before`, `compiled`, `prerender:done`, the miniflare dev exports) follow its documented extension points and are covered by tests that fake the instance plus a real build of `examples/nitro-vite`.
- Nitro 2 buffers responses on Cloudflare (`localFetch`): streaming SSR and event streams arrive in one piece there. Node and Vercel stream.
- WebSocket upgrades go to Nitro directly on Cloudflare, without the pipeline.
- Cloudflare's `_headers` holds at most 100 rules; documents beyond that are reported at build time and still get their CSP from the Worker when it serves them.
- The pipeline asks Nitro for identity-encoded responses (it may rewrite the body); compression is the CDN's or the reverse proxy's job.
- Facts rendered into a page that Nitro caches (`hyp()` in a `swr` route) are those of the request that filled the cache.
- The static presets (`static`, `github-pages`, `*-static`) have no server: the build still writes the manifest, but no pipeline runs.

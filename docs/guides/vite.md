# Hypdriv with plain Vite apps

`@hypdriv/vite` brings Hypdriv to Vite 8 apps without a server framework: single-page apps and multi-page static sites. The pipeline runs in front of the built files — on Cloudflare in a Worker that serves the static assets, on Vercel in Hypdriv's Routing Middleware, on Node in `hypdriv serve` — and every response the platform serves on its own carries Hypdriv's static header rules. Framework apps use their own package (`docs/guides/react-router.md`, `tanstack-start.md`, `astro.md`, `sveltekit.md`, `nuxt.md`, `vinext.md`, `waku.md`, `rwsdk.md`, `solid-start.md`, `qwik.md`), built on the same toolkit.

## Install

```sh
pnpm add @hypdriv/vite @hypdriv/core
pnpm add -D @hypdriv/cli          # hypdriv doctor / routes / audit / serve
```

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [hypdriv()] });
```

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'my-app', origin: 'https://www.example.com' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
});
```

## What the build produces

`vite build` writes `.hypdriv/manifest.json` with one route per built HTML page (`index.html` → `/`, `about.html` → `/about`) and, for a single-page app, a catch-all route (`/[...path]`) served by the shell. Each page records its client assets, the CSP hashes of its inline scripts and styles (taken from the final HTML, after Vite's minification), Early Hints and the speculation graph. `hypdriv routes` and `hypdriv manifest --summary` print it.

A build with one HTML entry is a single-page app unless `appType: 'mpa'` is set; force either with `hypdriv({ spa: true | false })`.

## Cloudflare

Use `@cloudflare/vite-plugin` with a Worker in front of the assets, so every navigation runs the pipeline:

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/*", "!/assets/*"]
  },
  "durable_objects": {
    "bindings": [
      { "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" },
      { "name": "HYPDRIV_INDEX", "class_name": "HypDrivIndex" },
      { "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }
    ]
  },
  "migrations": [{ "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }]
}
```

```ts
// src/worker.ts
/// <reference types="@hypdriv/vite/virtual" />
import { assetsWorker } from '@hypdriv/vite/worker';
import config from 'virtual:hypdriv/config';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

export default assetsWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  handle(request) {
    // Your own API next to the static app; return null to serve the assets.
    if (new URL(request.url).pathname === '/api/time') return Response.json({ now: Date.now() });
    return null;
  },
});
```

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/vite';
export default defineConfig({ plugins: [cloudflare(), hypdriv()] });
```

The plugin writes `dist/client/_headers` (merged with yours from `public/_headers`): the security preset on `/*`, each page's hash CSP and Early Hints, immutable caching on `/assets/*`. For a single-page app the shell's policy goes on `/*` and is detached (`! content-security-policy`) from the asset rules, so no response carries two policies. `.vite/` is added to `.assetsignore`. The Worker is built before the client, so the plugin patches the final manifest into the built Worker afterwards. When the Worker fetches a page from `env.ASSETS`, the `_headers` policy (marked `x-hypdriv-csp`) is replaced by the request's own (with the edge-injected Speculation Rules hash).

Without a Worker (assets only), the `_headers` rules alone give static pages their headers; the request stages (rate limiting, bot shield, maintenance, geo, flags, redirects) need the Worker.

`vite preview` runs the built Worker in workerd; `wrangler deploy` uploads `dist/`.

## Vercel

Build on Vercel (`VERCEL=1`) or with `HYPDRIV_TARGET=vercel`: the plugin writes `.vercel/output` (Build Output API v3) itself —

- `static/`: the client files (`.vite/` and Cloudflare-only files removed),
- header routes before `handle: filesystem` (security preset, page CSPs, Early Hints, immutable assets),
- `functions/_hypdriv/middleware.func`: Hypdriv's Routing Middleware, a bundled Node.js function that runs the request stages before the CDN for every path except content-hashed assets (`hypdriv({ vercelMiddleware: false })` leaves it out),
- the SPA fallback (`/index.html` for unknown extensionless paths) or clean URLs for multi-page builds.

Vercel deploys the directory as is (`vercel build && vercel deploy --prebuilt`, or a Git deployment whose build command is `vite build`). Vercel services (Global Config, Upstash, WAF rules) are picked up from the environment like on Next.js; see `docs/guides/vercel.md`.

## Node

```sh
vite build
hypdriv serve --dir dist          # PORT / HOST honoured; --trust-proxy behind a reverse proxy
```

`hypdriv serve` (or `serve()` from `@hypdriv/vite/node`) serves the build behind the full pipeline: `/x` resolves `x`, `x.html` and `x/index.html`, dotfiles are refused, `/assets/*` is cached immutably, HTML revalidates, single-page apps fall back to `index.html` for navigations only.

## Development

`vite dev` and `vite preview` run the pipeline around HTML documents (`hypdriv({ dev: false })` turns it off). In development Vite injects CSS as `<style>` elements from JavaScript; the plugin adds `<meta property="csp-nonce">` with the request nonce so they pass the strict policy.

## Checks

```sh
hypdriv doctor        # Vite host checks: integration, registration, manifest, _headers, run_worker_first, Durable Objects, Build Output
hypdriv routes        # pages, classifications, CSP mode
hypdriv audit all --url http://localhost:4173
```

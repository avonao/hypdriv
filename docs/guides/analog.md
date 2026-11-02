# Analog

`@hypdriv/analog` brings Hypdriv to [Analog](https://analogjs.org), the Angular meta-framework on Vite and Nitro. It runs the Hypdriv Drivetrain around every response Analog's Nitro server sends — server-rendered and prerendered pages, API routes — with security headers, CSP (nonces for rendered pages, hashes for prerendered ones), rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, tracing, Server-Timing and the `/_hypdriv/*` routes. It writes the route manifest from Analog's file router and the platform's static headers. It targets **Analog 2.9+ on Angular 19+, Vite 8 and Nitro 2** (`nitropack`) with the `cloudflare-module`, `vercel` and `node-server` presets, and is a thin layer over [`@hypdriv/nitro`](nitro.md), which does the Nitro work.

## Setup

```sh
pnpm add @hypdriv/analog @hypdriv/core
```

```ts
// vite.config.ts
import analog from '@analogjs/platform';
import { hypdriv, withHypDriv } from '@hypdriv/analog';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: { target: ['es2022'] },
  resolve: { mainFields: ['module'] },
  plugins: [
    analog(
      // withHypDriv() adds the Hypdriv Nitro module to nitro.modules and reads Analog's layout options.
      withHypDriv({
        ssr: true,
        // Prerendered pages are served by the platform with a hash CSP; every other page is rendered per request.
        prerender: { routes: ['/', '/about'] },
        nitro: { preset: process.env.HYPDRIV_TARGET === 'cloudflare' ? 'cloudflare-module' : undefined },
      }),
    ),
    // The Vite plugin: the client build's manifest (per-page assets, Early Hints, budgets) and /_hypdriv/* in `vite dev`.
    hypdriv(),
  ],
}));
```

```ts
// src/app/app.config.server.ts
import { type ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';
import { provideHypDriv } from '@hypdriv/analog/angular/server';
import { appConfig } from './app.config';

const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(), provideHypDriv()],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
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
});
```

`hypdriv init` makes these edits (including the arrow form of `defineConfig(({ mode }) => ({ … }))` Analog's template uses); `hypdriv doctor` checks them. `examples/analog` is a complete app — two prerendered pages, per-request pages that read the request with `injectHyp()`, Nitro API routes — that builds for all three platforms: `HYPDRIV_TARGET=cloudflare|vercel|node vite build` (default: `vercel` when `VERCEL=1`, else `cloudflare`). `create-hypdriv --framework analog` scaffolds it.

### Cloudflare Workers

Use the `cloudflare-module` preset with `cloudflare: { deployConfig: true }` in `analog({ nitro })` so Nitro writes the Worker's configuration from your `wrangler.jsonc` (it adds `main` and the assets directory) to `dist/analog/server/wrangler.json`:

```ts
nitro: { preset: 'cloudflare-module', compatibilityDate: '2026-10-01', cloudflare: { deployConfig: true } },
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
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

`vite build`, then `wrangler dev` / `wrangler deploy` from the project (Nitro points them at `dist/analog/server/wrangler.json`). The Worker is Hypdriv's shell around Nitro with the Durable Objects exported; `assets.run_worker_first` sends navigations through the Worker so prerendered pages get the request stages too, while `/assets/*` (Vite's hashed output) is answered by Workers Static Assets. The Durable Objects are optional upgrades: without the bindings, rate limits count per isolate and tag purges are TTL-bounded. Everything the [Nitro guide](nitro.md#cloudflare-workers) says about the Worker entry applies.

### Vercel

Use the `vercel` preset (Vercel's build sets it; Analog chooses it when `VERCEL=1`). The pipeline runs inside the Nitro function; after the build Hypdriv adds its header routes to `.vercel/output/config.json` and a Routing Middleware so prerendered pages also get the request stages. Deploy with `vercel deploy --prebuilt` or Git integration.

### Node

Use `node-server`; `vite build` writes `dist/analog/server/index.mjs`, started with `node dist/analog/server/index.mjs`. Every request except immutable build assets (`/assets/*`) goes through the pipeline, prerendered pages included. Behind a proxy set `security.trustedProxies`.

## What runs where

| | Cloudflare (`cloudflare-module`) | Vercel | Node |
|---|---|---|---|
| Rendered pages, API routes | Hypdriv Worker shell around Nitro (`runner: worker`) | Nitro hook in the function (`runner: host`) | Nitro hook (`runner: host`) |
| Prerendered pages | the shell with `run_worker_first`, served from the assets binding | Vercel CDN + header routes + Routing Middleware | Nitro hook |
| `/assets/*` (hashed client build) | Workers Static Assets | Vercel CDN | Nitro, without the pipeline |
| `vite dev` | Pages: Vite's SSR (not wrapped). API routes: Nitro's dev server behind the pipeline. `/_hypdriv/*`: the Vite plugin | | |

## Request context

**Angular components** read the request on the server with `injectHyp()` from the browser-safe entry:

```ts
import { injectHyp } from '@hypdriv/analog/angular';

const hyp = injectHyp(); // server: request id, runner, route, country, locale, CSP mode, flags; browser: null
```

`injectHyp()` is `null` in the browser and in `vite dev`: hand what a page shows over with Angular's `TransferState`, so hydration finds the markup it expects (`examples/analog/src/app/request-facts.ts`). `provideHypDriv()` provides it, together with Angular's `CSP_NONCE` (see CSP). Components that write their own `<script nonce>` while rendering use `injectNonce()` from `@hypdriv/analog/angular/server`.

Two entries, on purpose: `@hypdriv/analog/angular` has no runtime code, so importing it from a component adds nothing to the browser bundle; `@hypdriv/analog/angular/server` imports the Hypdriv runtime and belongs in `app.config.server.ts` only.

**API routes** (`src/server/routes`, the files Nitro serves under `/api`) read the context from `@hypdriv/analog/server`:

```ts
// src/server/routes/api/hello.ts
import { flag, hyp } from '@hypdriv/analog/server';
import { defineEventHandler } from 'h3';

export default defineEventHandler(() => ({ requestId: hyp()?.requestId, newHero: flag('newHero', false) }));
```

`@hypdriv/analog/server` exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler`.

## CSP

- **Rendered pages** use nonce mode. `provideHypDriv()` provides `CSP_NONCE`, so Angular stamps the request's nonce on the styles it renders, and it sets `ngCspNonce` on the root element so the browser-side Angular uses the same nonce for styles it adds later. The pipeline injects the nonce into any other script or style tag that carries none, idempotently.
- **Prerendered pages** use hash mode: the build hashes their inline scripts and styles, and the platform sends the policy from `_headers` / `config.json` (Node: the pipeline, at run time).
- The default policy allows `style-src 'self' 'unsafe-inline'`, which Angular's component styles need without a nonce; the client-side nonce only matters when you tighten `security.csp` to nonce-only styles.
- **Zone.js applications** may lose the `AsyncLocalStorage` context across Zone boundaries; `injectNonce()` and `CSP_NONCE` then fall back to the nonce the pipeline hands the application in the request's `x-nonce` header (read through Analog's `injectRequest()`), so the nonce survives. Zoneless applications keep the context.
- **Your own policy wins**: if a route sets `Content-Security-Policy` itself, Hypdriv keeps it and reports `x-hypdriv-csp: app`.
- Renders that Nitro caches (`routeRules` with `swr` or `cache` on an SSR route) are cached with the first request's nonce in the markup; the pipeline injects the current request's nonce into the cached document, but Angular's own nonce attributes inside it stay the first request's. Prerender such routes (hash mode) instead.

## Build output

`vite build` builds the client (`dist/client`), the server-side rendering bundle (`dist/ssr`) and the Nitro server (`dist/analog`: `public`, `server`). Hypdriv writes `.hypdriv/manifest.json`: the file router's pages (`src/app/pages/**/*.page.ts`, `*.md` content routes when `@analogjs/content` is installed, and the layout options `sourceRoot`, `workspaceRoot`, `additionalPagesDirs`, `additionalContentDirs`) and every Nitro handler as an endpoint, with their classification, per-page client assets from the Vite client manifest, CSP hashes and Early Hints of prerendered pages, budgets and the secrets scan. The server bundle embeds the final manifest, the module verifies it in every server file, and the platform's static headers are written. `.vite/manifest.json` is removed from the public output after it was read (it would otherwise be served), and Analog's hashed `/assets/*` files get `cache-control: public, max-age=31536000, immutable`.

## Options

`withHypDriv(analogOptions, options)` and `hypdrivAnalog(options)` take the [`@hypdriv/nitro` options](nitro.md#options) plus `sourceRoot`, `workspaceRoot`, `additionalPagesDirs`, `additionalContentDirs` and `contentRoutes`; `hypdriv(options)` takes `config` and `root`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The build ends with empty chunks and `"default" is not exported by …` in the SSR renderer | `tsconfig.app.json` (or a config it extends) has `"noEmit": true`: Analog's Angular compiler plugin then emits nothing | Remove `noEmit` from `tsconfig.app.json`; typecheck with a separate tsconfig (`examples/analog/tsconfig.check.json`). `hypdriv doctor` reports it as `analog.tsconfig-emit` |
| Angular's tags carry no nonce and `injectHyp()` is `null` in a rendered page | `provideHypDriv()` is not in the server application config | Add it to `app.config.server.ts` (`analog.server-providers` in `hypdriv doctor`) |
| Hydration errors or flicker after SSR on pages that show request facts | The browser rendered different markup than the server | Put the facts in `TransferState` on the server and read them back in the browser |
| The browser bundle grew by the Hypdriv runtime | `@hypdriv/analog/angular/server` (or `@hypdriv/analog/server`) was imported from browser code | Import `injectHyp` from `@hypdriv/analog/angular` in components; keep the server entries in server code |
| `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` for `@parcel/watcher`, `lmdb` or `msgpackr-extract` | pnpm blocks the optional native build scripts of `@angular/build` | Approve or deny them in `pnpm-workspace.yaml` (`allowBuilds`); the build does not need them |
| No Hypdriv lines in the build log | Analog builds Nitro at log level 0 | Warnings still reach `console.warn`; `hypdriv doctor` and `hypdriv routes` show the rest |
| `vite dev`: pages carry no Hypdriv headers | Pages are rendered by Vite's SSR, outside Nitro | Expected; check headers on a build served by `node dist/analog/server/index.mjs` or `wrangler dev` |
| Cloudflare: `cloudflare-pages` preset builds `_worker.js` and no Hypdriv Worker | The Pages presets use the in-app hook only | Use `cloudflare-module` with `cloudflare.deployConfig` (`nitro.cloudflare-preset` in `hypdriv doctor`) |

## Limitations

- Analog 3 (Nitro 3, beta) is inside the peer range but not yet exercised by this package's tests; the Nitro 3 module itself is built and checked by `examples/nitro-vite`.
- `vite dev` renders pages with Vite's server-side rendering: the request stages and security headers apply to the Nitro server (API routes), not to the dev pages.
- Prerendering runs Analog's own prerenderer (Nitro's): prerendered files carry no request's nonce and use hash mode.
- Everything in the Nitro guide's limitations applies: Nitro 2 buffers responses on Cloudflare, WebSocket upgrades bypass the pipeline, the `_headers` file holds at most 100 rules.

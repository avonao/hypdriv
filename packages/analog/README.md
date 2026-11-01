# @hypdriv/analog

Hypdriv for **Analog**, the Angular meta-framework on Vite and Nitro: the Hypdriv Drivetrain — security headers, CSP (nonces for rendered pages, hashes for prerendered ones), rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, tracing, Server-Timing and the `/_hypdriv/*` routes — around every response Analog's Nitro server sends, the file router's pages and API routes in the route manifest, and static headers for **Cloudflare Workers**, **Vercel** and **Node**.

Requires Analog 2.9+ (Nitro 2) and Vite 8. It builds on [`@hypdriv/nitro`](../nitro).

```sh
pnpm add @hypdriv/analog @hypdriv/core
```

```ts
// vite.config.ts
import { withHypDriv, hypdriv } from '@hypdriv/analog';
import analog from '@analogjs/platform';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  plugins: [
    analog(
      withHypDriv({
        ssr: true,
        prerender: { routes: ['/', '/about'] },
        nitro: { preset: process.env.HYPDRIV_TARGET === 'cloudflare' ? 'cloudflare-module' : undefined },
      }),
    ),
    hypdriv(),
  ],
}));
```

`withHypDriv()` adds the Nitro module to `analog({ nitro: { modules } })` and reads the layout options Analog's file router uses (`sourceRoot`, `workspaceRoot`, `additionalPagesDirs`, `additionalContentDirs`) from the same object. `hypdriv()` is the Vite plugin: it makes the client build write `.vite/manifest.json` (the source of per-page assets, Early Hints and budgets) and answers `/_hypdriv/*` in `vite dev`.

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }] },
  performance: { earlyHints: true },
});
```

## Server rendering and the CSP nonce

```ts
// src/app/app.config.server.ts
import { mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';
import { provideHypDriv } from '@hypdriv/analog/angular';
import { appConfig } from './app.config';

export const config = mergeApplicationConfig(appConfig, {
  providers: [provideServerRendering(), provideHypDriv()],
});
```

`provideHypDriv()` (server config only) provides Angular's `CSP_NONCE` as the request's nonce, so Angular stamps it on the styles it renders, and `HYP_CONTEXT` for `injectHyp()`. Prerendered pages carry hashes instead; outside Hypdriv's pipeline (`vite dev`) both are inert.

```ts
import { injectHyp, injectNonce } from '@hypdriv/analog/angular';

const hyp = injectHyp(); // request id, runner, route, country, locale, CSP mode, flags — or null
```

API routes (`src/server/routes`) read the context from `@hypdriv/analog/server` (`hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler`).

## Platforms

| Nitro preset | How the pipeline runs | Static headers |
|---|---|---|
| `cloudflare-module` | Hypdriv's Worker entry: the Worker shell around Nitro, with `scheduled` / `queue` / `email` dispatch and the Hypdriv Durable Objects exported | `_headers` in the assets directory |
| `vercel` | Inside the Nitro function, plus Routing Middleware for prerendered pages | Build Output `config.json` header routes |
| `node-server` | Inside Nitro, for every request except immutable build assets | — |

## Options

`withHypDriv(analogOptions, options)` and `hypdrivAnalog(options)` take the [`@hypdriv/nitro` options](../nitro#options) (`config`, `dev`, `nonce`, `staticHeaders`, `vercel.middleware`, `cloudflare.worker`, `cloudflare.exports`, `assetPrefixes`) plus `sourceRoot`, `workspaceRoot`, `additionalPagesDirs`, `additionalContentDirs` and `contentRoutes` (Markdown content routes; on when the project depends on `@analogjs/content`).

## How it works

- **Pages:** the manifest lists the file router's pages (`src/app/pages/**/*.page.ts`, plus Markdown content routes) with their source files; every Nitro handler (`src/server/routes`, page endpoints) is an endpoint. Prerendered documents are classified static (hash CSP); the rest are dynamic (nonce CSP).
- **Assets:** each page's chunk, its static imports and CSS come from the Vite client build's manifest and feed Early Hints and the asset budgets.
- **Dev:** `vite dev` renders pages with Vite's SSR; Hypdriv answers `/_hypdriv/*` there and runs the pipeline on the Nitro dev server (API routes).

See [the Analog guide](../../docs/guides/analog.md) for setup per platform, what runs where and the limitations, and [`examples/analog`](../../examples/analog) for an app that builds for all three platforms.

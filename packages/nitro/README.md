# @hypdriv/nitro

Hypdriv for **Nitro 2** (`nitropack`) and **Nitro 3** (`nitro`): a Nitro module that runs the Hypdriv Drivetrain — security headers, CSP (nonces for rendered pages, hashes for prerendered ones), rate limiting, the bot shield, geo, feature flags, i18n, redirects, maintenance mode, Early Hints, logging, tracing, Server-Timing and the `/_hypdriv/*` routes — around every Nitro response, and writes the route manifest and the platform's static headers for **Cloudflare Workers**, **Vercel** and **Node**.

It is the shared Nitro layer of the hosts built on Nitro: [`@hypdriv/analog`](../analog) uses it, and a plain Nitro server or a Vite app with `nitro/vite` uses it directly.

```sh
pnpm add @hypdriv/nitro @hypdriv/core
```

## Nitro 2 (`nitropack`), or Nitro 3 without Vite

```ts
// nitro.config.ts
import { hypdrivNitro } from '@hypdriv/nitro';
import { defineNitroConfig } from 'nitropack/config';

export default defineNitroConfig({
  modules: [hypdrivNitro()],
});
```

## Nitro 3 with Vite (`nitro/vite`)

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/nitro/vite';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [nitro(), hypdriv()] });
```

`hypdriv()` is a Vite plugin that carries a `nitro` key, which `nitro()` registers as a Nitro module; it also turns on the client build's manifest.

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }] },
  performance: { earlyHints: true },
});
```

## Platforms

| Preset | How the pipeline runs | Static headers |
|---|---|---|
| `cloudflare-module` | Hypdriv's Worker entry: the Worker shell (`createWorker`) around Nitro, with `scheduled` / `queue` / `email` dispatch and the Hypdriv Durable Objects exported | `_headers` in the assets directory |
| `vercel` | Inside the Nitro function (it owns the response), plus Routing Middleware for the prerendered pages Vercel's CDN serves without the function | Build Output `config.json` header routes |
| `node-server` | Inside Nitro, for every request except immutable build assets | — (prerendered pages are served through the pipeline) |

Other Cloudflare presets (`cloudflare-pages`, `cloudflare-durable`) and `cloudflare.worker: false` use the in-app hook. The development server runs the pipeline too (`dev: false` turns it off). Static presets and Nitro's prerender instance are left alone.

## Options

| Option | Default | |
|---|---|---|
| `config` | `hypdriv.config.*` in the root | Config file path or inline config |
| `root` | Nitro's `rootDir` | Project root |
| `dev` | `true` | Run the pipeline in the development server |
| `nonce` | `true` | Hand the CSP nonce to the application (`event.context.hypdriv.nonce`, the `x-nonce` request header) |
| `staticHeaders` | `true` | Write `_headers` / `config.json` header routes |
| `vercel.middleware` | `true` | Routing Middleware for prerendered pages on Vercel |
| `cloudflare.worker` | `true` | Use Hypdriv's Worker entry for `cloudflare-module` |
| `cloudflare.exports` | — | Module whose named exports the Worker entry re-exports (your Durable Objects, Workflows…) |
| `assetPrefixes` | `['/assets/']` | Immutable build-asset prefixes answered without the pipeline |

Framework hosts add `framework`, `routes`, `isPage`, `internalPages`, `pageAssets` and `clientManifest` (see `HypdrivNitroOptions`).

## Request context

```ts
// server/routes/api/whoami.ts
import { flag, hyp } from '@hypdriv/nitro/server';

export default defineEventHandler(() => ({ requestId: hyp()?.requestId, newHero: flag('newHero', false) }));
```

`@hypdriv/nitro/server` exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler`. On Nitro 2 the same facts are on `event.context.hypdriv`.

## How it works

- **Runtime:** a Nitro plugin wraps the app's request handler (Nitro 2: `h3App.handler`; Nitro 3: `fetch`). Request stages run first and may answer on their own; otherwise Nitro renders into a capture response inside the request's `AsyncLocalStorage` context, and the response stages post-process the captured head and streaming body before it reaches the client. Nitro's prerender instance is not wrapped.
- **CSP:** rendered pages get a per-request nonce, injected into the markup the pipeline sees; prerendered pages use the hashes computed at build time; an application-set policy is kept.
- **Build:** Nitro's handlers and the prerendered documents become `.hypdriv/manifest.json`; the server bundle embeds the final manifest (verified in every output file after the build), and the static header rules go into `_headers` or `config.json`.

See [the Nitro guide](../../docs/guides/nitro.md) for setup per platform, what runs where and the limitations, and the examples [`examples/nitro`](../../examples/nitro) (Nitro 2) and [`examples/nitro-vite`](../../examples/nitro-vite) (Nitro 3 with Vite), which build for all three platforms.

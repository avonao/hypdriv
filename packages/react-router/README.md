# @hypdriv/react-router

Hypdriv for [React Router](https://reactrouter.com) 8 in framework mode: the Drivetrain — security headers, CSP with build-time hashes or per-request nonces, rate limiting, bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, request ids, logging, tracing and `/_hypdriv/*` — around every request of a React Router app on Cloudflare Workers, Vercel and Node.

```sh
pnpm add @hypdriv/react-router @hypdriv/core
```

## Setup

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/react-router';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [hypdriv(), reactRouter()] });
```

```ts
// react-router.config.ts
import { hypdrivPreset } from '@hypdriv/react-router';
import type { Config } from '@react-router/dev/config';

export default { ssr: true, prerender: ['/'], presets: [hypdrivPreset()] } satisfies Config;
```

```tsx
// app/root.tsx
import { hypdrivMiddleware } from '@hypdriv/react-router/server';
export const middleware = [hypdrivMiddleware()];
```

```ts
// app/entry.server.tsx — React Router's entry with Hypdriv's CSP nonce
export { default, streamTimeout } from '@hypdriv/react-router/entry.server';
```

`hypdriv.config.ts` in the project root configures the stages (`defineConfig` from `@hypdriv/core`).

## Entry points

| Import | What it is |
| --- | --- |
| `@hypdriv/react-router` | `hypdriv()` (Vite plugin: virtual modules, server entry, prerender marking, dev `/_hypdriv/*`), `hypdrivPreset()` (finalises the build), route discovery and build helpers |
| `@hypdriv/react-router/server` | `hypdrivMiddleware()`, `createServerEntry()`, `hypdrivContext`, `cloudflareContext`, `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler`, data-request helpers |
| `@hypdriv/react-router/entry.server` | `handleRequest` / `createHandleRequest()` with the nonce on `ServerRouter` and React's scripts |
| `@hypdriv/react-router/cloudflare` | `reactRouterWorker()`: Hypdriv's Worker shell around React Router (assets first, SPA shell, `scheduled` / `queue` / `email`) |
| `@hypdriv/react-router/node` | `serve()`, `createRequestListener()`, `loadServer()`; the `hypdriv-react-router-serve` binary |

## What runs where

| Platform | Outer runner (every request) | Static pages |
| --- | --- | --- |
| Cloudflare | `workers/app.ts` → `reactRouterWorker({ config })`, `assets.run_worker_first` | through the Worker (hash CSP), `_headers` as fallback |
| Vercel | the function of each server bundle (Hypdriv's server entry) | Build Output header routes + Hypdriv's Routing Middleware |
| Node | `hypdriv-react-router-serve` | through the server (hash CSP) |

The root middleware runs the pipeline wherever no outer runner exists — `react-router dev`, `react-router-serve`, custom Express servers — and passes through inside one.

## Build

`hypdrivPreset()` runs after React Router's build (prerendering included): it discovers the routes (resource routes become endpoints), the prerendered documents and per-route assets, writes `.hypdriv/manifest.json`, patches the final manifest into the server output, erases the build's prerender token from it, and writes Cloudflare `_headers` or the Vercel Build Output (`.vercel/output`: static files, Hypdriv's header routes, one Node.js function per server bundle traced with `@vercel/nft`, `@vercel/react-router` route `config` honoured). The target comes from `hypdriv({ target })`, `HYPDRIV_TARGET`, `VERCEL=1` or the Cloudflare Vite plugin.

React Router's prerender requests carry a random per-build token (injected on the build's preview server, compiled into the server build); the middleware and the Worker entry skip the pipeline for them, and the token is erased from the output once prerendering finished — production requests can never skip.

See the [React Router guide](../../docs/guides/react-router.md) for platform setup, CSP behaviour and limitations.

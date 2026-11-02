# @hypdriv/vite

[Hypdriv](https://github.com/avonao/hypdriv) for Vite 8: the plugin for plain Vite apps and the toolkit behind `@hypdriv/react-router`, `@hypdriv/tanstack-start`, `@hypdriv/astro`, `@hypdriv/sveltekit`, `@hypdriv/nuxt`, `@hypdriv/vinext`, `@hypdriv/waku`, `@hypdriv/rwsdk`, `@hypdriv/solid-start`, `@hypdriv/qwik`, `@hypdriv/nitro` and `@hypdriv/analog`.

## Plain Vite apps

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/vite';
export default defineConfig({ plugins: [hypdriv()] });
```

`vite build` writes `.hypdriv/manifest.json` (pages from the built HTML, their CSP hashes, assets and Early Hints; a catch-all route for single-page apps) and the static configuration of the platform it detects:

| Platform | What you get |
| --- | --- |
| **Cloudflare** (`@cloudflare/vite-plugin`) | `_headers` with Hypdriv's security preset, the hash CSP and Early Hints of each page (the SPA shell's policy on the catch-all), immutable caching for `/assets/*`; `.vite` kept out of the upload. With a Worker in front of the assets (`assetsWorker()` from `@hypdriv/vite/worker`, `run_worker_first`), every navigation gets the full pipeline, `/_hypdriv/*`, Durable Objects, `scheduled`/`queue`; the final manifest is patched into the built Worker. |
| **Vercel** (`VERCEL=1`) | `.vercel/output` (Build Output API v3): the static files, header routes, clean URLs / SPA fallback, and Hypdriv's Routing Middleware (a bundled Node.js function) so the request stages run before the CDN. |
| **Node** | `hypdriv serve` (or `serve()` from `@hypdriv/vite/node`): the build behind the full pipeline, with content-hash caching and SPA fallback. |

`vite dev` and `vite preview` run the pipeline around HTML documents (Vite's dev styles get the request nonce through `meta[property=csp-nonce]`).

```ts
// src/worker.ts — wrangler `main` (Cloudflare, Worker first)
/// <reference types="@hypdriv/vite/virtual" />
import { assetsWorker } from '@hypdriv/vite/worker';
import config from 'virtual:hypdriv/config';
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
export default assetsWorker({ config, manifest: () => import('virtual:hypdriv/manifest') });
```

## Toolkit for framework integrations

- `hostPlugin()` — loads `hypdriv.config.*` and serves `virtual:hypdriv/config` and `virtual:hypdriv/manifest` to server code.
- Route converters — `fromColonPath` (React Router), `fromTanStackPath`, `fromVueRouterPath` (Nuxt), `fromSvelteKitId` → Hypdriv's canonical `[param]` / `[...rest]` / `[[optional]]` patterns; `toHypRoute()`.
- `finalizeManifest()` — routes + prerendered documents + client directory → the manifest (via `@hypdriv/build`), `.hypdriv/manifest.json` and the build report.
- `rulesFor()`, `writeCloudflareStatic()`, `writeVercelStatic()`, `writeVercelOutput()` — static headers per platform.
- `patchRuntimeManifest()` — replaces the manifest embedded in built server bundles once prerendering is done (ADR 0019).
- `@hypdriv/vite/node` — `toWebRequest`, `sendWebResponse`, `createStaticHandler`, `serve`.

See `docs/guides/vite.md`.

# @hypdriv/solid-start

Hypdriv for [SolidStart 2](https://docs.solidjs.com/solid-start) (Solid, Vite 8 and Nitro 3) on Cloudflare Workers, Vercel and Node: the Drivetrain — security headers, CSP with per-request nonces (handed to Solid's renderer) or build-time hashes, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — wrapped around SolidStart's server from outside, plus a Vite plugin that writes the route manifest after Nitro has prerendered and the platform's static headers.

Full guide: [`docs/guides/solid-start.md`](../../docs/guides/solid-start.md).

## Setup

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/solid-start/vite';
import { solidStart } from '@solidjs/start/config';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    solidStart(),
    nitro({ preset: 'node-server' }), // 'vercel' on Vercel; or @cloudflare/vite-plugin first for Workers
    hypdriv(), // after solidStart() and the deployment plugin
  ],
  nitro: { prerender: { routes: ['/', '/about'] } },
});
```

```tsx
// src/entry-server.tsx — the request's nonce on every inline script Solid renders
import { hypdrivStart } from '@hypdriv/solid-start';
import { createHandler, StartServer } from '@solidjs/start/server';

export default createHandler(() => <StartServer document={…} />, hypdrivStart());
```

```ts
// server functions, API routes
import { flag, hyp } from '@hypdriv/solid-start/server';
```

```jsonc
// tsconfig.json / src/global.d.ts: /// <reference types="@hypdriv/solid-start/virtual" />
```

Nothing else is needed on Node and Vercel: the Vite plugin registers a Nitro module whose runtime plugin wraps `nitroApp.fetch`, so prerendered documents, API routes, server functions (`/_server`) and rendered pages all pass through the pipeline.

## Entry points

| Entry | Contents |
| --- | --- |
| `@hypdriv/solid-start` | `hypdrivStart()`, `installFetchHook()`, `solidSkip()`, `platformInput()`; inert stand-ins in the browser (`browser` export condition) |
| `@hypdriv/solid-start/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` |
| `@hypdriv/solid-start/vite` | `hypdriv()`, route discovery and output helpers |
| `@hypdriv/solid-start/nitro` | The Nitro runtime plugin (registered by `hypdriv()`; nothing to import by hand) |
| `@hypdriv/solid-start/cloudflare` | `createSolidStartWorker()` (Worker shell around SolidStart: `scheduled`/`queue`/`email`, Durable Objects), `startApp()` |
| `@hypdriv/solid-start/virtual` | Types of `virtual:hypdriv/config` and `virtual:hypdriv/manifest` |

## Platforms

- **Cloudflare Workers** with `@cloudflare/vite-plugin` (`viteEnvironment: { name: 'ssr' }`): `wrangler.jsonc` `main` is your `src/worker.ts` exporting `createSolidStartWorker({ config, manifest, entry })` and the Hypdriv Durable Objects. The build writes `dist/client/_headers` and patches the manifest into `dist/server`. Every page renders per request (SolidStart prerenders only through Nitro).
- **Cloudflare Workers** with Nitro's `cloudflare_module` preset: the Nitro runtime plugin runs in the Worker; prerendered pages are served by Workers Static Assets with the hash policy from `_headers`.
- **Vercel** (Nitro `vercel` preset): header routes and clean-URL `overrides` in `.vercel/output/config.json`, Hypdriv's Routing Middleware for prerendered pages, the manifest patched into the function.
- **Node** (Nitro `node-server`): `node .output/server/index.mjs`; `routeRules` give hashed assets their headers, and prerendered pages are answered by Nitro inside the pipeline, which applies their hash policy.

Nitro's prerender build never runs the pipeline, so static documents never contain one request's nonce, id or flags; the build fails if one does.

## License

MIT

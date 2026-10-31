# Hypdriv with React Router

`@hypdriv/react-router` runs the Hypdriv Drivetrain around a React Router 8 app in framework mode — security headers, CSP (build-time hashes for prerendered pages, per-request nonces for rendered ones), rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, request ids, logging, tracing and the `/_hypdriv/*` routes — on Cloudflare Workers, Vercel and Node. It needs React Router 8.0+ (`react-router`, `@react-router/dev`), React 19.2.7+, Vite 8 and Node 22.22+.

The integration has four parts:

| Part | Where | Job |
| --- | --- | --- |
| `hypdriv()` | `vite.config.ts` | serves `virtual:hypdriv/config`, `virtual:hypdriv/manifest` and the build's prerender token to server code; makes Hypdriv's server entry the SSR entry of Node and Vercel builds; marks React Router's prerender requests; answers `/_hypdriv/*` in `react-router dev` |
| `hypdrivPreset()` | `react-router.config.ts` | after the complete build (prerendering included): the manifest, the patched server output and the platform's static configuration |
| `hypdrivMiddleware()` | `app/root.tsx` | the pipeline around every request React Router routes, wherever no outer Hypdriv runner exists |
| `entry.server` | `app/entry.server.tsx` | the request's CSP nonce on every script `ServerRouter` and React render |

## Setup

```sh
pnpm add @hypdriv/react-router @hypdriv/core
```

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

export default {
  ssr: true,
  prerender: ['/', '/about'],
  presets: [hypdrivPreset()],
} satisfies Config;
```

```tsx
// app/root.tsx
import { hypdrivMiddleware } from '@hypdriv/react-router/server';
import type { Route } from './+types/root';

export const middleware: Route.MiddlewareFunction[] = [hypdrivMiddleware()];
```

```ts
// app/entry.server.tsx
export { default, streamTimeout } from '@hypdriv/react-router/entry.server';
```

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'my-app' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
});
```

The build target comes from `hypdriv({ target })`, else `HYPDRIV_TARGET`, else `vercel` when building on Vercel (`VERCEL=1`), else `cloudflare` when `@cloudflare/vite-plugin` is in the Vite config, else `node`. `examples/react-router` is one app that builds for all three.

## Cloudflare Workers

React Router's server environment is the Worker; its entry wraps React Router with Hypdriv's Worker shell, so the pipeline runs for every request the Worker receives — routes, 404s, `/__manifest`, prerendered pages and public files.

```ts
// vite.config.ts
plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), hypdriv(), reactRouter()]
```

```ts
// workers/app.ts
/// <reference types="@hypdriv/vite/virtual" />
import config from 'virtual:hypdriv/config';
import { reactRouterWorker } from '@hypdriv/react-router/cloudflare';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
export default reactRouterWorker({ config });
```

```jsonc
// wrangler.jsonc
{
  "main": "workers/app.ts",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "html_handling": "drop-trailing-slash", // about/index.html answers /about, the URL React Router links to
    "not_found_handling": "none",           // unknown paths reach React Router
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

`reactRouterWorker()` answers GET/HEAD requests from the assets binding first (prerendered pages, `.data` files, public files), serves the SPA shell for unknown navigations of `ssr: false` apps, and hands everything else to React Router. Content-hashed assets bypass the Worker (`!/assets/*`) and carry the immutable caching rule Hypdriv writes into `build/client/_headers`, which also holds the security headers and hash CSP of every prerendered page (the rules a static response gets if the Worker does not run for it). When the Worker serves a page from the assets binding, the request's own policy replaces the static one.

React Router 8 sets no `context.cloudflare`. Loaders reach the platform through `context.get(cloudflareContext)` (`env`, `ctx`, `cf`, set by the Worker entry), `import { env } from 'cloudflare:workers'`, or `hyp().env`. `getLoadContext({ request, env, ctx, context })` adds your own values. `scheduled`, `queue` and `email` dispatch Hypdriv's jobs (`jobs.cron`, `jobs.queues`) to `jobHandler()` resource routes.

```sh
HYPDRIV_TARGET=cloudflare react-router build && vite preview   # workerd
HYPDRIV_TARGET=cloudflare react-router build && wrangler deploy
```

## Vercel

On Vercel, Hypdriv writes the Build Output itself (`.vercel/output`), and `vercel build` deploys it as is:

- `static/` — the client build (prerendered pages, `.data` files, assets, public files);
- Hypdriv's header routes before the filesystem — the security headers on every path, immutable caching for `/assets/*`, and each prerendered page's hash CSP and Early Hints (restricted to GET/HEAD, so form posts reach the function with its own policy);
- prerendered pages rewritten for GET/HEAD (`/about` → `/about/index.html`);
- one Node.js function per server bundle: Hypdriv's server entry, which runs the pipeline around React Router for every request it receives (404s, 405s and `/__manifest` included). Its files are traced with `@vercel/nft` like Vercel's own builders do;
- Hypdriv's Routing Middleware in front of the statically served paths (request stages: shield, bots, rate limits, redirects, maintenance, geo, flags), unless `hypdrivPreset({ vercelMiddleware: false })`.

Per-route function settings use `@vercel/react-router`'s preset: it splits the server build by each route's `export const config = { maxDuration, memory, regions }`, and Hypdriv deploys every bundle as its own function with those settings. The Edge runtime is not supported (`runtime: 'edge'` fails the build): Hypdriv runs React Router on Vercel's Node.js runtime.

```ts
// react-router.config.ts
import { vercelPreset } from '@vercel/react-router/vite';
export default { ssr: true, presets: [vercelPreset(), hypdrivPreset()] } satisfies Config;
```

`@vercel/react-router` 1.3.7 still declares React Router 7 peers. It works with React Router 8; tell your package manager:

```yaml
# pnpm-workspace.yaml (pnpm 10+)
peerDependencyRules:
  allowedVersions:
    "@vercel/react-router>@react-router/dev": "8"
    "@vercel/react-router>@react-router/node": "8"
```

With npm, add `legacy-peer-deps=true` to `.npmrc`. Background work in loaders (`defer()`, `hyp().waitUntil`) uses Vercel's `waitUntil` automatically; skew protection (`VERCEL_SKEW_PROTECTION_ENABLED`) gets the same document cookie route Vercel's builder adds.

```sh
VERCEL=1 react-router build      # or: vercel build
vercel deploy --prebuilt
```

## Node

```sh
HYPDRIV_TARGET=node react-router build
hypdriv-react-router-serve ./build/server/index.js   # PORT, HOST; --trust-proxy behind a reverse proxy
```

On Node builds, Hypdriv's Vite plugin makes its server entry the SSR entry: `build/server/index.js` still exports React Router's server build and additionally `hypdriv` (the full-response handler) and a default `(request) => Response`. `hypdriv-react-router-serve` (or `serve()` / `createRequestListener()` from `@hypdriv/react-router/node`) runs the pipeline around every request — prerendered pages with their hash CSP, public files, React Router, 404s — serves `/assets/*` with immutable caching, gzips static files and passes the socket address as the client IP.

`react-router-serve ./build/server/index.js` keeps working: the root middleware runs the pipeline for routed requests, while Express serves static files and answers 404s without it, and rate limits key on forwarded headers only (configure `security.trustedProxies` behind a proxy). For your own Express or `node:http` server, use `createRequestListener()` or call `build.hypdriv.fetch(request, { ip, assets })`.

## Development

`react-router dev` runs the root middleware around routed requests (nonces, `hyp()`, flags, rate limits) and answers `/_hypdriv/*` from the dev server. With the Cloudflare Vite plugin, development runs the Worker entry in workerd.

## Request context in application code

```ts
import { flag, hyp, hypdrivContext, requireHyp } from '@hypdriv/react-router/server';

export function loader({ context }: Route.LoaderArgs) {
  const request = requireHyp();               // throws outside a Hypdriv request
  const same = context.get(hypdrivContext);   // the same view through the router context
  return { id: request.requestId, country: request.country, newHero: flag('newHero', false) };
}
```

`hyp()` returns `null` during prerendering: prerendered pages carry no per-request data.

## CSP

| Response | Policy | Scripts |
| --- | --- | --- |
| Rendered per request (SSR, 404s, error pages) | nonce (`'strict-dynamic'`) | `ServerRouter nonce` and React's `nonce` render it on every script, modulepreload link and streamed chunk; the pipeline adds it to scripts that lack one |
| Prerendered page | hash: the build's hashes of its inline scripts | rendered without a nonce at build time |
| Prerendered page on Cloudflare (Worker first), Node | the request's policy (hash for static routes) | `_headers` rules are replaced, never duplicated |
| Prerendered page on Vercel | the header route of the page | Routing Middleware adds request stages, not a second policy |
| SPA shell (`ssr: false`) | the shell's hashes on every deep link | |

A policy the application sets itself (a route `headers` export) wins: the csp stage never overrides it. Without `app/entry.server.tsx`, React Router's default entry renders without nonces; the pipeline then injects the nonce into the HTML stream.

## Data requests

React Router fetches route data and submits actions through `<path>.data`. Hypdriv extends the rules that gate requests — rate limits, CSRF, body-size limits, bot exemptions, maintenance bypass paths and redirect rules — with those spellings, so `match: '/login'` also covers client-side submissions to `/login.data`. A redirect the pipeline answers for a data request becomes a single-fetch redirect (`204` + `X-Remix-Redirect`, followed as a document navigation); other responses the pipeline answers itself (429, 403, 503) reach the nearest `ErrorBoundary`.

## Prerendering

React Router prerenders through a preview server it starts during the build. Hypdriv generates a random 256-bit token per build, injects it into the prerender requests on that server (`x-hypdriv-prerender`) and compiles it into the server build; the root middleware, the server entry and the Worker entry skip the pipeline for requests that carry it. Once prerendering finished, the preset erases the token from the server output (code and source maps), so a deployed build has none and no request — whatever headers it sends — can skip the pipeline. `X-React-Router-Prerender` alone means nothing to Hypdriv.

## Limitations

- **Outside an outer runner** (`react-router-serve`, custom servers that call React Router directly) the root middleware covers routed requests only: static files, 404s, 405s and `/__manifest` get no Hypdriv headers, and `/_hypdriv/*` is not answered. Use the Worker entry, Hypdriv's Node server or the Vercel output for full coverage.
- **Vercel Edge runtime** bundles are rejected; Node.js functions only.
- **React Server Components** (`unstable_rsc` framework mode) and `ssr: 'unstable_api-only'` are not supported.
- On Vercel, statically served pages get the request stages from the Routing Middleware and their headers from the header routes; their response headers are fixed at build time (no per-request nonce).
- Redirect rules whose `from` ends in a wildcard get no `.data` spelling; `/**` patterns already match nested data requests.
- Early Hints list module scripts as `rel=preload; as=script`.

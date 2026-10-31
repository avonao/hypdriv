# Hypdriv with TanStack Start

`@hypdriv/tanstack-start` runs the Drivetrain — security headers, CSP with per-request nonces or build-time hashes, rate limiting, the bot shield, geo, feature flags, i18n, redirects, maintenance mode, the edge cache, Early Hints, logging, tracing and `Server-Timing`, and the `/_hypdriv/*` internal routes — around a [TanStack Start](https://tanstack.com/start) (React) application on Cloudflare Workers, Vercel and Node. It follows ADR 0019 (Vite hosts): the request runtime is TanStack Start's own global request middleware, the build side is a Vite plugin that finalises the Hypdriv manifest once prerendering is done.

Requirements: `@tanstack/react-start` 1.169 or later, Vite 8, Node.js 22.12 or later (Nitro 3 needs 22.22 for Vercel and Node builds).

## What runs where

| Request | Cloudflare Workers | Vercel | Node (Nitro) |
| --- | --- | --- | --- |
| SSR page, server route, server function, 404, Start's redirects | Worker shell (`createStartWorker`) with `HTMLRewriter`; the request middleware passes through | request middleware in the Vercel Function | request middleware (or the server entry) in the Node server |
| `/_hypdriv/*` | Worker shell | request middleware | request middleware |
| Prerendered page | the Worker shell (with `assets.run_worker_first`), served as built from the assets binding with its hash CSP; without it Workers Static Assets with its `_headers` rule | Vercel CDN with its Build Output header route (hash CSP …) at its clean URL, behind Hypdriv's Routing Middleware (request stages) | rendered per request by Start (nonce CSP) — see *Node and prerendered pages* |
| Hashed assets (`/assets/*`) | Static Assets, `_headers`: immutable caching + security headers | CDN, header route | Nitro, `routeRules`: immutable caching + security headers |
| Other public files (`robots.txt`) | Static Assets, `_headers` base rule | CDN, header route | Nitro (no Hypdriv headers) |
| Start's prerender requests (`vite build`) | Start only, no pipeline | Start only | Start only |

Every HTML response the pipeline renders carries a nonce policy: Start puts the nonce on every script, style and preload it renders. Prerendered documents served by the platform carry the hash policy computed from the exact file.

## Setup

```sh
pnpm add @hypdriv/tanstack-start @hypdriv/core
```

### `vite.config.ts`

```ts
import { hypdriv, withHypDriv } from '@hypdriv/tanstack-start/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tanstackStart(
      withHypDriv({
        prerender: { enabled: true },
        pages: [{ path: '/' }, { path: '/about' }],
      }),
    ),
    viteReact(),
    hypdriv(), // after tanstackStart() (and nitro()): it finalises the manifest after prerendering
  ],
});
```

`withHypDriv()` prepares Start's options:

- **Prerender requests are marked.** It adds `x-hypdriv-prerender: <token>` to Start's prerender requests (globally, and to pages or the SPA shell that set their own `headers`, which replace the global ones). The token is 32 random bytes generated per build; the request middleware (and the Worker shell, and the server entry) let those requests through to Start untouched, so no request's nonce, id or flags end up in a static file. After prerendering, the plugin removes the token from the server output: a deployed server never accepts it, and a forged header is just a header.
- **Prerendered pages are written as `about.html`** (`prerender.autoSubfolderIndex: false`, unless you set it). Start's router answers `/about` and redirects `/about/` to it; Workers Static Assets serve `about.html` at `/about` (and redirect `/about/`), while `about/index.html` would be redirected to `/about/`. Vercel and Node follow the same URL.
- **Route discovery follows your router options** (`srcDirectory`, `router.routesDirectory`, file tokens, virtual routes).

The build fails with an explanation when a prerendered page contains a CSP nonce (the pipeline ran during prerendering — usually because `withHypDriv()` is missing), or when `hypdriv()` is listed before `tanstackStart()`.

### `hypdriv.config.ts`

```ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'storefront', origin: 'https://shop.example.com' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
  flags: { definitions: { newHero: { default: false, rules: [{ when: { country: ['US'] }, value: true }] } } },
});
```

### `src/start.ts` — the request middleware and CSRF

```ts
import { hypdrivRequestMiddleware } from '@hypdriv/tanstack-start';
import { createStart } from '@tanstack/react-start';

const requestMiddleware = hypdrivRequestMiddleware();

export const startInstance = createStart(() => ({ requestMiddleware }));
```

`hypdrivRequestMiddleware()` returns `[hypdriv, csrf]`:

1. **Hypdriv first.** Global request middleware runs for SSR documents, server routes, server functions, not-found pages, Start's trailing-slash redirects and HEAD requests. Listed first, Hypdriv wraps every response the middleware after it produces — a CSRF rejection gets the request id, the security headers, logging and rate limiting like any other response.
2. **Start's CSRF protection for server functions.** A custom `src/start.ts` replaces Start's default request middleware, which is where Start installs `createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })`; Hypdriv adds exactly that back. Adjust it with `hypdrivRequestMiddleware({ csrf: { secFetchSite: ['same-origin', 'same-site'] } })`, or pass `csrf: false` only when you install your own CSRF middleware.

For a custom order use the pieces: `hypdrivMiddleware()` and Start's `createCsrfMiddleware()`. Create middleware at module scope: Start evaluates the `createStart()` callback per request, and the pipeline's platform (rate-limit counters, caches) must outlive it — `hypdrivMiddleware()` and `hypdrivRequestMiddleware()` without options return shared instances.

`src/start.ts` is also part of the client bundle. In the browser, `@hypdriv/tanstack-start` resolves (export condition `browser`) to inert stand-ins, so neither the runtime nor your Hypdriv config nor the build manifest reach the client.

### `src/router.tsx` — the nonce for Start's own tags

```tsx
import { hypdrivSsr } from '@hypdriv/tanstack-start';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ssr: hypdrivSsr() });
}
```

The middleware hands the request's nonce to Start through `next({ context: { nonce } })` — Start's `BaseContext.nonce`, also visible to `getGlobalStartContext()`. `getRouter()` runs per request after the global middleware, and `hypdrivSsr()` turns that into the router's `ssr: { nonce }`, which TanStack Router puts on `HeadContent` (meta, links, styles, head scripts), `Scripts`, `ScriptOnce`, the streamed hydration scripts and React's stream, and publishes as `<meta property="csp-nonce">` for scripts and styles the client inserts later. In the browser and during prerendering it returns `undefined`.

Without it, the CSP still holds: the pipeline injects the nonce into script and style tags that lack one while streaming the response (`HTMLRewriter` on Workers, the portable tokenizer on Node and Vercel). The router option is what makes client-side insertions carry it too.

### Request facts in application code

```ts
// src/request-facts.ts
import { flag, hyp } from '@hypdriv/tanstack-start/server';
import { createServerFn } from '@tanstack/react-start';

export const getRequestFacts = createServerFn({ method: 'GET' }).handler(async () => ({
  requestId: hyp()?.requestId ?? null,
  nonce: hyp()?.nonce ?? null,
  newHero: flag('newHero', false),
}));
```

`@hypdriv/tanstack-start/server` re-exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler` from `@hypdriv/runtime`. They read the request context the middleware (or the Worker shell) installed with `AsyncLocalStorage`, so they work in server functions, server routes, request and function middleware, and server-only code (`createIsomorphicFn().server()`). Route loaders are isomorphic — they also run in the browser on client-side navigations — so call a server function from the loader, as above (in the browser the entry resolves to stand-ins that report "no request").

Job endpoints use `jobHandler` in a server route; on Cloudflare the Worker shell's `scheduled`, `queue` and `email` handlers call them with signed requests (`jobs` in `hypdriv.config.ts`, `HYPDRIV_INTERNAL_SECRET`), on Vercel Vercel Cron calls them with `CRON_SECRET`.

## Cloudflare Workers

Use `@cloudflare/vite-plugin` (as Start's docs do) and make your own file the Worker entry — with Start's package entry as `main`, wrangler ignores your exports (Durable Objects, handlers):

```ts
// vite.config.ts
plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart(withHypDriv({ ... })), viteReact(), hypdriv()]
```

```ts
// src/worker.ts
/// <reference types="@hypdriv/vite/virtual" />
import config from 'virtual:hypdriv/config';
import { createStartWorker } from '@hypdriv/tanstack-start/cloudflare';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

export default createStartWorker({ config, manifest: () => import('virtual:hypdriv/manifest') });
```

```jsonc
// wrangler.jsonc
{
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  // The Worker runs first for everything except content-hashed assets: prerendered pages get the request stages.
  "assets": { "binding": "ASSETS", "run_worker_first": ["/*", "!/assets/*"] },
  "triggers": { "crons": ["0 * * * *"] },
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

`createStartWorker()` is `createWorker({ app })` from `@hypdriv/cloudflare` with Start's server entry as the application: the shell runs the full pipeline with `HTMLRewriter`, answers `/_hypdriv/*`, uses the Durable Objects for exact rate limits and the tag index when their bindings exist, and handles `scheduled`, `queue`, `email` and `tail`. Workers' `env` and `ctx` reach Start as `context.cloudflare` (they never land in Start's request options); `import { env, waitUntil } from 'cloudflare:workers'` works anywhere as well. The request middleware sees the shell's context and passes through, still forwarding the nonce. GET and HEAD requests are answered from the assets binding first (`assets: false` turns that off), so with `run_worker_first` prerendered pages and public files keep being served as built — prerendered pages with their build-time hash CSP — while they get rate limiting, the bot shield, geo and flags. Start's prerender requests (the build runs the Worker in workerd to prerender) go to Start directly. To compose it yourself:

```ts
import { createWorker } from '@hypdriv/cloudflare';
import { renderedManifestLoader, startApp } from '@hypdriv/tanstack-start/cloudflare';
export default createWorker({ config, manifest: renderedManifestLoader(() => import('virtual:hypdriv/manifest')), app: startApp() });
```

(this variant has no prerender bypass: use `createStartWorker()` when you prerender). Without a Worker entry of your own (`main: "@tanstack/react-start/server-entry"`), the request middleware runs the pipeline itself; bindings and `waitUntil` come from `cloudflare:workers`.

The build writes `dist/client/_headers` (merged with yours from `public/_headers`, within Cloudflare's 100-rule limit) and keeps `.vite`/`.hypdriv` out of the upload through `.assetsignore`; it patches the final manifest into `dist/server`. `vite preview` runs the result in workerd; `wrangler deploy` deploys it.

## Vercel

Build with Nitro's `vercel` preset (auto-detected on Vercel, where `VERCEL=1`):

```ts
import { nitro } from 'nitro/vite';
plugins: [tanstackStart(withHypDriv({ ... })), nitro(), viteReact(), hypdriv()]
```

After the build `.vercel/output` holds:

- `config.json` with Hypdriv's header routes before `{ "handle": "filesystem" }` — the security headers for every path, immutable caching for `/assets/*`, and one route per prerendered page with its hash CSP and Early Hints — plus `overrides` that serve `about.html` at `/about` from the CDN;
- the Vercel Function (`functions/__server.func`) with the final manifest patched into its bundle (and a copy at `.hypdriv/manifest.json`); inside it the request middleware runs the pipeline and, as the owner of the response, sets the Vercel CDN cache headers of each route's policy.

`request.waitUntil` (Nitro's Vercel runtime) keeps background work alive; Vercel's request-context `waitUntil` is the fallback. Deploy the prebuilt output (`vercel deploy --prebuilt`) or let Vercel build the project.

## Node

Build with Nitro (`nitro()`, preset `node-server`) and start `node .output/server/index.mjs` (`PORT`, `HOST`). Every request that is not a public file reaches the request middleware: client addresses come from the socket (`request.ip`; with `security.trustedProxies` set, from the forwarded headers instead) and background work from `request.waitUntil`. The plugin gives Nitro `routeRules` for the content-hashed assets (immutable caching plus the security headers); other public files are served by Nitro as they are.

### Node and prerendered pages

Nitro builds its public-asset table before TanStack Start prerenders, so `.output/public/about.html` exists but Nitro's server never serves it: on Node, prerendered paths are rendered by Start per request. Hypdriv accounts for this — whatever reaches Start is answered as a rendered page (`renderedManifest()`): a nonce policy instead of the hashes of a file that is not being sent, and no edge caching of per-request HTML — and the manifest does not count those documents as statically served. Put a CDN in front, or deploy to Vercel or Cloudflare, when prerendering should save rendering work.

### Optional: the server entry

```ts
// src/server.ts
export { default } from '@hypdriv/tanstack-start/server-entry';
```

The server entry runs the pipeline outside Start's request handler, so it also covers what Start answers around the request middleware: its error response for uncaught exceptions and the redirect of protocol-relative URLs. The request middleware stays registered and passes through below it. Use `createHypDrivServerEntry({ ... })` for options. (On Cloudflare the Worker shell is this outer layer.)

## Development

`vite dev` runs the same middleware around SSR, server routes and server functions — in Node, or in workerd with `@cloudflare/vite-plugin` (where `src/worker.ts` is the entry, so the shell runs too). The manifest lists the routes discovered so far, without prerender data; the dev pipeline adds `'unsafe-eval'` for Vite. `public/_headers` is not applied by Vite's dev server.

## Limitations

- **Static pages on Node** are rendered per request (see above).
- **SPA mode** (`spa.enabled`): the shell (`_shell.html`) gets a hash policy at `/_shell`; routing unknown paths to it is the host's configuration, and those responses carry that rule only where the platform applies it. On Cloudflare, Start renders the full page instead of the shell during prerendering (`TSS_PRERENDERING` is not visible in workerd — a Start limitation).
- **Router base path / Vite `base` other than `/`**: routes and documents are recorded under the base path; the static header rules use the document paths as written.
- **Route discovery** reads route options as TanStack's generator does: a route whose options are not an inline object literal is treated as a page.
- **Request headers**: Start renders with the original request; the pipeline's forwarded `x-hypdriv-*` headers are not visible on it. Read request facts through `hyp()` (they never come from client-supplied headers).
- Not verified on real Vercel or Cloudflare deployments here: Vercel's handling of `overrides` together with Nitro's routes, and Workers' `_headers` limits on large sites (`e2e/hosts` covers live checks).

# Hypdriv on Qwik

[Qwik](https://qwik.dev) is a resumable framework: pages render on the server, ship no hydration code and resume in the browser from the serialized state. Qwik Router (the file router, `routeLoader$`, `routeAction$`, middleware and endpoints; `@qwik.dev/router`) is the application layer on Vite. `@hypdriv/qwik` runs Hypdriv's Drivetrain around every request Qwik Router answers on Cloudflare Workers, Vercel and Node, and builds the Hypdriv manifest from the Qwik build. It follows the Vite host recipe of [ADR 0019](../adr/0019-vite-hosts.md) and the design in [ADR 0023](../adr/0023-qwik-host.md). The runnable example is [`examples/qwik`](../../examples/qwik).

Requirements: `@qwik.dev/core` and `@qwik.dev/router` `>=2.0.0-rc.4 <3` (the Qwik v2 release candidates; `hypdriv doctor` reports the pre-release as information), Vite 8, Node 20.19+. Qwik v1 (`@builder.io/qwik-city`) is not supported: its releases predate Vite 8. `qwik migrate-v2` moves an application, and `hypdriv init` and `hypdriv doctor` say so when they find v1.

## Install

```sh
pnpm add @hypdriv/qwik @hypdriv/core
pnpm add -D wrangler   # Cloudflare only
```

Add `hypdriv.config.ts` (see [configuration](./configuration.md)). Qwik already has a place for each of the three pieces Hypdriv adds, so there is nothing to patch.

**The plugin**, next to Qwik's two, in the base `vite.config.ts`:

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/qwik';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikRouter } from '@qwik.dev/router/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [qwikRouter(), qwikVite(), hypdriv()] });
```

**The adapter** of each target you build, in the file Qwik uses for server builds (`adapters/<target>/vite.config.ts`). It replaces Qwik's own adapter for that platform (`node-server`, `cloudflare-pages`, `vercel-edge`) and is written with the same documented `viteAdapter()` API:

```ts
// adapters/node/vite.config.ts
import { nodeAdapter } from '@hypdriv/qwik/adapters/node'; // …/vercel, …/cloudflare
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config';

export default extendConfig(baseConfig, () => ({
  build: { ssr: true, rolldownOptions: { input: ['src/entry.node.tsx'] } },
  plugins: [nodeAdapter({ ssg: { include: ['/*'], exclude: ['/api/*'] } })],
}));
```

**The server entry** of that target (`src/entry.<target>.tsx`), which creates the router with Hypdriv's `createQwikRouter` instead of Qwik's:

```tsx
// src/entry.node.tsx
import { createServer } from 'node:http';
import { createQwikRouter } from '@hypdriv/qwik/middleware/node';
import render from './entry.ssr';

const { listener } = createQwikRouter({ render });
createServer(listener).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
```

`hypdriv init` adds all three for an existing app (the plugin to `vite.config.ts`, including the function form Qwik's starter uses, and the adapter and entry of the chosen platform) and `npm create hypdriv@latest -- --framework qwik` scaffolds a complete one (`examples/qwik`). `src/entry.ssr.tsx` and your routes stay as they are; Qwik's `nonce` render option stays unused, because Hypdriv injects the nonce into the streamed HTML itself.

## Build and run

A Qwik production build is two Vite builds: the client build (`vite build`, the base config) and the server build with an adapter (`vite build -c adapters/<target>/vite.config.ts`), which also runs Qwik's static generation. Build both:

```sh
vite build && vite build -c adapters/node/vite.config.ts
```

The target is the adapter that builds the server (what is built wins over the environment). `detectTarget()` from `@hypdriv/qwik` answers for scripts that pick the adapter: `HYPDRIV_TARGET` (`cloudflare`, `vercel`, `node`), Vercel when `VERCEL=1`, Cloudflare when `CLOUDFLARE` or `WORKERS_CI` is set, else Node (`null` on Netlify, which has no Hypdriv runtime for Qwik). `examples/qwik/scripts/build.mjs` is a short script that picks the target this way and runs both builds; `pnpm build` runs it.

## How it works

**The entry.** `createQwikRouter` from `@hypdriv/qwik/middleware/node|vercel|cloudflare` wraps Qwik Router's `requestHandler` (the function every Qwik adapter calls) in a Web `fetch` and puts it behind `createHandler({ runner: 'host' })` from `@hypdriv/runtime`. Every request the entry answers passes the Drivetrain: pages, the route loader data (`q-loader-*.json`), actions (`routeAction$`, `server$`), endpoints and the static files of the client build.

- the HTTPS upgrade, security headers, CSP, rate limiting, the bot shield, geo, flags, redirects, maintenance, the edge cache, Early Hints, logging, tracing and `Server-Timing`;
- Hypdriv's internal routes (`/_hypdriv/health`, CSP reports, vitals, live polling, DevTools endpoints);
- `hyp()` in `routeLoader$`, `routeAction$`, `server$`, middleware and endpoints (`AsyncLocalStorage`).

The client address Qwik sees (`requestEv.clientConn`) is the one the pipeline resolved (trusted proxies, `CF-Connecting-IP`, Vercel's forwarded address, the socket), and the request body limit and streaming behave as in Qwik's own adapters (10 MiB by default).

**The adapter.** `viteAdapter()` is Qwik's: it runs the static generation after the server build, injects the static path list into the server bundle and removes the generated files it does not keep. Hypdriv's adapters add the platform output (below) and take the SSG origin from `site.origin` of the Hypdriv config when nothing names the site (`ORIGIN`, `VERCEL_PROJECT_PRODUCTION_URL`, `CF_PAGES_URL`, `ssg.origin`). Static generation is opt-in through `ssg: { include, exclude }`, as in Qwik: without it nothing is prerendered and every page renders per request.

**The build.** After the complete server build — Qwik's static generation and the adapter's output included — the plugin writes `.hypdriv/manifest.json` (and `report.md`): the routes from Qwik Router's route table, hashed client assets (`/build/*`, `/assets/*`) and Early Hints, the CSP hashes of every prerendered page, Purser verification, the secrets scan and budgets. It then patches the final manifest into every server output (the manifest embedded in the server bundle is built before static generation) and writes the platform's static layer. Budget, Purser or secrets failures fail the build. Qwik generates its static files before the pipeline exists, so prerendered HTML is Hypdriv-free (no nonce, no request facts) and the build hashes it.

**Routes.** The route table is Qwik Router's own (`getRoutes()` of its Vite plugin), so layouts, groups, `[param]` and `[...rest]` routes are exactly what Qwik serves. `.tsx`, `.jsx`, `.md` and `.mdx` modules are pages; `.ts` and `.js` modules are endpoints (`onGet`, `onPost`…). A dynamic route with `onStaticGenerate` stays a dynamic route; the concrete paths Qwik prerendered for it become static page routes of their own (`/blog/hello`, `/blog/qwik`) so they get a hash policy, and the route keeps the rest. The trailing slash of Qwik's route names is dropped in the manifest, which records whether the app uses trailing slashes. Routes the table cannot express (a computed segment next to literal text keeps Qwik's own matcher) and extra routes go in the plugin's `routes` option.

## Classification and CSP

| Route | When | CSP |
| --- | --- | --- |
| `static` | the page Qwik prerendered (`ssg` include/exclude, or a path from `onStaticGenerate`) | hash policy of the built document (`x-hypdriv-csp: hash`), applied by the platform's static headers where the platform serves the file and by the pipeline otherwise |
| `dynamic` | pages Qwik renders per request, route loader data | nonce policy; the nonce is injected into every `<script>` and `<style>` of the streamed HTML (`HTMLRewriter` on Workers, a streaming injector elsewhere) |
| `route` | endpoints (`onGet`, `onPost`…) | the route's own headers |

A policy the application sets itself (a `Content-Security-Policy` header from middleware or an endpoint) wins: the csp stage reports `x-hypdriv-csp: app` and leaves it alone. Qwik inlines its loader (`qwikloader`), the preloader and the serialized state (`qwik/state`, `qwik/vnode` and `q:func` scripts) in every document, so a prerendered page's hash policy covers exactly those inline scripts (the build hashes them) and `'unsafe-inline'` is kept only as the fallback CSP 3 browsers ignore. Use `nonce()` (or `hyp()?.nonce`) for scripts the application renders itself.

## Server helpers

```tsx
// src/routes/dynamic/index.tsx
import { component$ } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import { flag, geo, hyp } from '@hypdriv/qwik/server';

export const useFacts = routeLoader$(() => {
  const context = hyp(); // requestId, nonce, flags, geo, locale, runner, route, env, waitUntil…
  return { hero: flag('newHero', false) ? 'New hero' : 'Classic', country: geo()?.country ?? null };
});

export default component$(() => <p>{useFacts().value.hero}</p>);
```

`hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler` are re-exported from `@hypdriv/runtime`. Call them while Qwik handles a request — in loaders, actions, `server$` functions, middleware and endpoints — not from component bodies, which also run in the browser. Outside a request (the build-time prerender) `hyp()` returns `null`, so a loader that reads it belongs to a page that renders per request. `defer()` keeps work alive after the response; `jobHandler()` guards the endpoints `jobs.cron` / `jobs.queues` dispatch to (see [jobs](./jobs.md)).

## Node

```sh
vite build && vite build -c adapters/node/vite.config.ts
node server/entry.node.js          # port 3000 unless PORT is set
```

- The Node entry serves the client build (`dist`) itself: prerendered pages, content-hashed files and public files pass the pipeline like everything else, so they get the request stages and their hash policies, and content-hashed files (`/build/*`, `/assets/*`) get `Cache-Control: public, max-age=31536000, immutable`. `createQwikRouter` returns `router`, `staticFile` and `notFound` with the shapes of Qwik's own Node middleware (existing entries keep working) plus `listener`, the complete `http` request listener.
- The client address is the socket address unless `security.trustedProxies` is greater than zero: behind a proxy or load balancer set it to the number of proxies so the forwarded headers decide, or IP-keyed rate limits share the proxy's bucket. `ORIGIN`, `PROTOCOL_HEADER` and `HOST_HEADER` work as in Qwik's Node middleware.
- No platform services are needed; capabilities that need one (Durable Objects, Vercel CDN tags) report their baseline behaviour.

`pnpm preview` (`vite preview` with Qwik's preview entry) serves the Node build through the same pipeline for a quick look. Vite's static server answers `/build/*` itself with `no-cache`, so the hashed-asset caching check of `e2e-hosts check` fails against the preview (and passes against `node server/entry.node.js`, where the immutable caching is Hypdriv's).

## Cloudflare Workers

Hypdriv's Cloudflare adapter writes the Worker to `dist/_worker.js` (a module that re-exports the server bundle in `server/`) and leaves the client build in `dist` as the assets directory; `.assetsignore` keeps the Worker file out of the upload. Keep a `wrangler.jsonc` with the assets binding, the worker-first rule and the Durable Objects:

```jsonc
// wrangler.jsonc
{
  "name": "my-qwik-app",
  "main": "./dist/_worker.js",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": ["/*", "!/build/*", "!/assets/*"]
  },
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

- **Hypdriv's Worker shell.** The entry's default export is `createWorker()` around Qwik's request handler: the full Drivetrain with `runner: 'worker'` (`HTMLRewriter`, Durable Object rate limits and tag index when bound), Hypdriv's `scheduled`, `queue` and `email` dispatchers next to the `handlers` you pass (`createQwikRouter({ render, hypdriv: { handlers } })`; Hypdriv's take the events configured in `jobs`, yours take the rest), and `tail`.
- **Worker first.** `run_worker_first: ["/*", "!/build/*", "!/assets/*"]` sends every request but Qwik's content-hashed files through the Worker. For GET and HEAD the Worker asks the `ASSETS` binding first, so prerendered pages and public files are served as built — with the request stages (rate limits, bot shield, maintenance, redirects, flags) and their hash policies applied — and anything else is rendered by Qwik. Workers Static Assets answer `/build/*` and `/assets/*` before the Worker; `hypdriv audit https` checks that plain-HTTP asset requests are redirected, which needs HTTPS redirection in the zone (see [production Cloudflare](./production-cloudflare.md)).
- **Route loader data.** `<page>/q-loader-<id>.<hash>.json` is application data that looks like a file. Hypdriv's Cloudflare runner skips the pipeline for file-like paths (`cloudflare.skipStaticAssets`, default `true`), so set `cloudflare: { skipStaticAssets: false }` in `hypdriv.config.ts`: the Worker then runs the pipeline for loader data as well as for pages, while the content-hashed files still never reach it. `hypdriv doctor` (`qwik.loader-json`) reports a config that leaves it on.
- **Durable Objects.** Production builds export `HypDrivLimiter`, `HypDrivIndex` and `HypDrivChannel` from the Worker entry by themselves (the plugin appends them to the server build's entry, once), so no export is needed in `src/entry.cloudflare.tsx`. A Worker entry of your own re-exports them from `@hypdriv/qwik/durable-objects`; turn the automatic export off with `hypdriv({ durableObjects: false })`.
- **Static headers.** The plugin merges Hypdriv's rules (security preset, the immutable rule for `/build/*` and `/assets/*`, the documents' hash policies, Early Hints) into `dist/_headers`.
- **Account-specific configuration** stays in a git-ignored `wrangler.<name>.local.jsonc` (`wrangler dev --config`); secrets for local runs go in `.dev.vars`.

Build with `HYPDRIV_TARGET=cloudflare` (or `vite build -c adapters/cloudflare/vite.config.ts` after the client build), run locally with `wrangler dev`, deploy with `wrangler deploy`. Cloudflare's Workers Builds sets `WORKERS_CI`, which selects the target.

## Vercel

```sh
VERCEL=1 vite build && VERCEL=1 vite build -c adapters/vercel/vite.config.ts   # Vercel's build command; HYPDRIV_TARGET=vercel works too
```

The server build's `outDir` must be the Build Output function directory, `.vercel/output/functions/_qwik-router.func` (see the adapter file above; `hypdriv doctor` reports `qwik.vercel-outdir` and `hypdriv init` writes it). The adapter writes the Build Output API (`.vercel/output`) with one Node.js function (Web handler, response streaming) behind a catch-all route, copies the client build to `.vercel/output/static`, and the plugin adds, after the build:

- **Static pages at clean URLs.** Prerendered documents in `.vercel/output/static` are served by the CDN without invoking the function, with Hypdriv's static header rules and their hash CSP; `/build/*` and `/assets/*` get immutable caching.
- **Routing Middleware for those pages.** Hypdriv's prerender-scoped middleware (GET/HEAD, only the prerendered paths) runs the request stages — rate limits, the bot shield, maintenance, redirects, geo — for documents the CDN would otherwise serve untouched, before the filesystem. Turn it off with `hypdriv({ vercelMiddleware: false })`.
- **The function** receives everything else — pages rendered on demand, loader data, actions, endpoints — and runs the pipeline once, with Vercel's platform wiring: the Vercel CDN stage owns the function's cache headers, tag purges go to Vercel, Upstash / Global Config / WAF / BotID when configured. Like Qwik's own Vercel adapter it sets the skew-protection cookie when skew protection is on.
- The function's embedded manifest and `.hypdriv/manifest.json` are the final ones (the build warns when no Build Output exists, which means the Hypdriv Vercel adapter is not building the server).

Deploy with `vercel deploy --prebuilt` or a Git deployment with Vercel's build command set as above.

## Development

`vite --mode ssr` is Qwik's SSR dev server. The Hypdriv plugin runs the pipeline around it: CSP nonces, `hyp()`, flags, rate limits and `/_hypdriv/*` behave as in production, with `'unsafe-eval'` and the HMR WebSocket allowed in the CSP while the server is in development. Vite's own modules, HMR and assets are left alone; documents, loader data, actions and endpoints are wrapped. Turn the dev pipeline off with `hypdriv({ dev: false })`.

## Options

`hypdriv(options)` from `@hypdriv/qwik`:

| Option | Default | Purpose |
| --- | --- | --- |
| `config` | `hypdriv.config.*` in the project root | a path or an inline Hypdriv config |
| `target` | the adapter that builds the server | `cloudflare`, `vercel` or `node` |
| `routes` | none | extra routes, or a function that returns the final list |
| `vercelMiddleware` | `true` | Hypdriv's Routing Middleware for the CDN's prerendered pages |
| `durableObjects` | `true` | export the Durable Object classes from the Worker entry |
| `dev` | `true` | run the pipeline around the dev server |

`createQwikRouter({ render, hypdriv })` takes Qwik's own options plus `hypdriv: { … }`: the `createHandler` options (`stages`, `onError`, a `config` or `manifest` override) and, on Cloudflare, `assets` (the static-assets binding name, `false` to send everything to Qwik) and `handlers`. The adapters take Qwik's `ssg` options plus `config` (where `site.origin` is read) and `staticPaths`.

## Limitations

- Qwik v2 is a release candidate: the peer range is pinned to `>=2.0.0-rc.4 <3`, and `build.test.ts` runs the real Qwik builds for Node and Vercel, so a change in Qwik or Qwik Router fails the tests instead of production. Qwik v1 (`@builder.io/qwik-city`) is unsupported; its Vite peer range excludes Vite 8.
- Qwik's own adapters for other platforms (Netlify, AWS Lambda, Deno, Bun, static export) are left alone: `hypdriv()` still writes the manifest, but the Drivetrain only runs where a Hypdriv entry is the server.
- Two warnings of a server build come from Qwik and do not affect the output. Qwik Router logs "Qwik Router SSG was skipped" from the plugin instance of the server environment although static generation runs afterwards (the build log ends with the prerendered page count, and `hypdriv routes` lists them). Rolldown reports `INEFFECTIVE_DYNAMIC_IMPORT` for `@qwik.dev/router`'s lazily imported entry.
- Hypdriv's Node server for Vite hosts (`hypdriv serve`) is not used: `node server/entry.node.js` is Qwik's server entry with the Hypdriv listener.
- Verified locally with a real Node server and `vite preview`, workerd (`wrangler dev` on the built Worker), a real `vercel build` with the function invoked in process, and the dev server. A real browser's resumption, prefetching and SPA navigation under the CSP, live Cloudflare and Vercel deployments, the Vercel CDN's own behaviour and edge purges on a real zone need a deployment (`e2e/hosts`).

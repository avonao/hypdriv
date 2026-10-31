# Astro

`@hypdriv/astro` adds Hypdriv to an Astro 7 app on Cloudflare Workers (`@astrojs/cloudflare`), Vercel (`@astrojs/vercel`) and Node (`@astrojs/node`). It is one Astro integration: it wraps Astro's request handling with the Hypdriv Drivetrain through Astro middleware, and after `astro build` writes the Hypdriv manifest and the static header rules of the adapter's platform. The design follows [ADR 0019](../adr/0019-vite-hosts.md). A runnable app that builds for all three platforms lives in [`examples/astro`](../../examples/astro).

## Install

```sh
pnpm add @hypdriv/astro @hypdriv/core
```

```js
// astro.config.mjs
import cloudflare from '@astrojs/cloudflare';
import hypdriv from '@hypdriv/astro';
import { defineConfig } from 'astro/config';

export default defineConfig({
  adapter: cloudflare(),
  integrations: [hypdriv()],
});
```

The Hypdriv config lives in `hypdriv.config.ts` next to `astro.config.*` (or pass `hypdriv({ config: './path/to/config.ts' })`; an inline object works too as long as it holds no functions). Options:

| Option | Default | |
| --- | --- | --- |
| `config` | `hypdriv.config.*` in the project root | config file path or inline config |
| `targets` | the adapter's platform | `['cloudflare' \| 'vercel' \| 'node']`: whose static configuration the build writes |
| `internalRoutes` | `true` with an adapter | inject the on-demand route `/_hypdriv/[...path]` (see below) |

Application code reads the request context through `@hypdriv/astro/server`:

```astro
---
import { flag, hyp, nonce } from '@hypdriv/astro/server';
export const prerender = false;
const ctx = hyp(); // null during build-time prerendering
---
<p data-request={ctx?.requestId}>New hero: {String(flag('newHero', false))}</p>
<script is:inline nonce={nonce()} src="https://widgets.example.com/embed.js"></script>
```

`hyp()`, `requireHyp()`, `nonce()`, `flag()`, `geo()` and `defer()` work in pages, layouts, components, endpoints, server islands and actions. `jobRoute(options, handler)` is `jobHandler()` shaped as an Astro endpoint, for Hypdriv's signed jobs and Vercel Cron:

```ts
// src/pages/api/jobs/[job].ts
import { jobRoute } from '@hypdriv/astro/server';
export const prerender = false;
export const POST = jobRoute({}, async ({ job, payload }) => ({ job, payload }));
export const GET = POST; // Vercel Cron calls with GET
```

## What runs where

| Request | Cloudflare (Worker shell) | Cloudflare (adapter entry) | Vercel | Node (`@astrojs/node` standalone) |
| --- | --- | --- | --- | --- |
| On-demand pages, endpoints, server islands, actions | Worker shell | middleware | middleware (function) | middleware |
| Prerendered pages | Worker shell (hash CSP from the manifest) | `_headers` | Build Output header routes | `dist/_headers.json` (`staticHeaders: true`) |
| `/_hypdriv/*` | Worker shell | injected route → middleware | injected route → middleware | injected route → middleware |
| Unmatched URLs (prerendered `404.astro`) | Worker shell | `src/fetch.ts` wrapper | static 404 with the error page's CSP | `src/fetch.ts` wrapper |
| Config `redirects` | `_redirects` (the adapter writes it) | `_redirects` | the adapter's Build Output routes | `src/fetch.ts` wrapper |
| Trailing-slash redirects | Worker shell | `src/fetch.ts` wrapper | `src/fetch.ts` wrapper | `src/fetch.ts` wrapper |
| `/_astro/*` | `_headers` (immutable) | `_headers` | header routes | Astro's static handler |

**Middleware.** The integration registers `@hypdriv/astro/middleware` with `addMiddleware({ order: 'pre' })`, so it wraps your own `src/middleware.ts` (Astro's origin check still runs first). It calls `createHandler()` from `@hypdriv/runtime` with `next()` as the upstream: the stages run before and after rendering, `hyp()` is available everywhere below it, and on Cloudflare it hands over `locals.cfContext.waitUntil` and `request.cf` (bindings come from `cloudflare:workers`). The client IP is Astro's `clientAddress`. On Vercel, `waitUntil` comes from Vercel's request context.

**Build-time prerendering never runs the pipeline.** Astro prerenders with a separate bundle (its `prerender` Vite environment); the integration serves that bundle a `virtual:hypdriv/astro` module whose `prerendering` constant is `true`, so the middleware and `src/fetch.ts` pass every prerender request through. The flag is fixed at build time and no request can change it. In addition, a route marked `prerender = true` is only ever rendered at build time in production (`context.isPrerendered` comes from Astro's route table, not from the request). In `astro dev` prerendered routes render per request and do run the pipeline.

**Internal routes.** Astro runs middleware only for routes it matches, and answers unmatched paths with the prerendered 404 page without middleware. The integration injects the on-demand endpoint `/_hypdriv/[...path]` so `/_hypdriv/health`, CSP reports, Web Vitals and the DevTools endpoints reach Hypdriv in production. This makes the build a server build (an adapter is required for Hypdriv's runtime anyway); turn it off with `internalRoutes: false`.

**Error pages.** When a route throws, Astro renders `500.astro` and runs the middleware a second time for the same request; an empty 404/500 response (`new Response(null, { status: 404 })`) is rerouted to the error page the same way. Hypdriv recognises that second pass: it applies the response stages (security headers, CSP with a fresh nonce injected into the error page, request id, `Server-Timing`) but skips the stages that count or judge the request — rate limiting (local and Vercel WAF), the bot shield, the request shield and CSRF — because they already ran for it. A thrown error without an on-demand `500.astro` gets Astro's plain 500 response.

### `src/fetch.ts`: the pipeline around everything Astro answers

Astro 7's advanced routing entry sees every request that reaches the Astro app, including what Astro answers before middleware. Wrap it to extend the pipeline to unmatched URLs, config redirects and trailing-slash redirects:

```ts
// src/fetch.ts
import { withHypDriv } from '@hypdriv/astro/fetch';
import { astro } from 'astro/fetch';

export default withHypDriv((state) => astro(state));
```

The middleware passes through inside it, so the pipeline runs once per request (and the error-page pass is part of that single run). Static files the platform serves itself still bypass it.

## Cloudflare

Two setups:

1. **Worker shell (recommended).** Own the Worker entry and wrap Astro's handler with `createWorker({ app })` from `@hypdriv/cloudflare`. The shell runs the Drivetrain for every request that reaches the Worker — prerendered pages fetched from `env.ASSETS` and unmatched URLs included — exports Hypdriv's Durable Objects (exact rate limiting, the tag index, live channels) and dispatches `scheduled`, `queue` and `email` events to Hypdriv jobs. The middleware inside Astro passes through: the shell already ran the stages.

   ```jsonc
   // wrangler.jsonc
   {
     "name": "my-site",
     "main": "./src/worker.ts",
     "compatibility_date": "2026-10-01",
     "compatibility_flags": ["nodejs_compat"],
     "assets": { "binding": "ASSETS", "directory": "./dist/client", "run_worker_first": ["/*", "!/_astro/*"] },
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
   /// <reference types="@hypdriv/astro/virtual" />
   import { handle } from '@astrojs/cloudflare/handler';
   import { createWorker } from '@hypdriv/cloudflare';
   import config from 'virtual:hypdriv/config';

   export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

   // Astro's handler is typed with @cloudflare/workers-types; the shell passes the same request, env and ctx.
   type AstroHandle = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

   export default createWorker({
     config,
     manifest: () => import('virtual:hypdriv/manifest'),
     app: async () => ({ fetch: (request, env, ctx) => (handle as AstroHandle)(request, env, ctx) }),
   });
   ```

   `@astrojs/cloudflare` uses `main` from your wrangler config, also in `astro dev` and `astro preview` (workerd). `astro build && wrangler deploy` deploys `dist/server/wrangler.json`.

2. **Adapter entry.** Without a `main`, Astro's own entry serves the app: the middleware covers on-demand routes and Cloudflare serves prerendered pages and assets before the Worker with Hypdriv's rules from `_headers`.

The build merges Hypdriv's rules into `dist/client/_headers` inside a marked block (the adapter's `/_astro/*` caching and your `public/_headers` are kept; duplicate headers for the same path are left out, Cloudflare would join them with a comma), keeps `.hypdriv` out of the upload through `.assetsignore`, and patches the final manifest into `dist/server`. Cloudflare allows 100 `_headers` rules; documents beyond that are reported in the build log and get their policy from the Worker shell.

## Vercel

```js
import vercel from '@astrojs/vercel';
export default defineConfig({ adapter: vercel(), integrations: [hypdriv()] });
```

The function (`.vercel/output/functions/_render.func`) runs the middleware for every on-demand route; Vercel's CDN serves prerendered pages. After the adapter wrote `.vercel/output`, the build inserts Hypdriv's header routes before `{ "handle": "filesystem" }` in `config.json` (security headers on every path, the hash CSP and Early Hints of each prerendered page, immutable caching for `/_astro/*`), adds the 404 page's policy to the adapter's catch-all error route, copies the manifest into every function and patches the final manifest into the function code. With `isr`, Astro's classic middleware runs only when a page regenerates (Vercel's docs); cached ISR responses keep the headers of their render.

## Node

```js
import node from '@astrojs/node';
export default defineConfig({
  adapter: node({ mode: 'standalone', staticHeaders: true }),
  integrations: [hypdriv()],
});
```

`node dist/server/entry.mjs` serves static files first and renders everything else; the middleware runs for every on-demand route. With `staticHeaders: true` the standalone server reads `dist/_headers.json` for prerendered pages, and Hypdriv writes its rules there (security headers, hash CSP, Early Hints), merged with the entries Astro writes. The server picks the first entry whose path contains the request path, so Hypdriv writes an exact entry for every prerendered path and both trailing-slash spellings, shortest first. Without `staticHeaders` the build warns: prerendered pages would be served without Hypdriv's headers. Add the `src/fetch.ts` wrapper to cover unmatched URLs. Behind a proxy, configure Astro's `security.allowedDomains` so `clientAddress` (the rate-limit key) comes from `X-Forwarded-For`; otherwise it is the socket address.

## CSP

- **Astro's `security.csp` off (the default): Hypdriv owns the policy.** On-demand responses use nonce mode: the stage generates a nonce per request, sends `script-src 'self' 'nonce-…' 'strict-dynamic'` and injects the nonce into every `<script>` (and `<style>` when `unsafeInlineStyles` is off) — Astro's hoisted module scripts, island bootstraps, the server-island loader and `is:inline` scripts alike — with `HTMLRewriter` on Workers and a streaming tokenizer on Vercel and Node. Code that renders its own tags reads `hyp().nonce` / `nonce()`. Prerendered pages get hash mode: the build hashes every inline script and style of each document and the platform serves the policy statically (`_headers`, header routes, `_headers.json`); behind the Worker shell the stage sends the same policy from the manifest.
- **Astro's `security.csp` on: Astro owns the policy.** Astro emits hashes only (no nonces): a `<meta>` tag on prerendered pages (a header through the adapter with `staticHeaders`), a header on on-demand pages; it does not hash `is:inline` scripts. The integration then switches Hypdriv's CSP off for the app — `virtual:hypdriv/config` (used by the middleware, `src/fetch.ts` and a Worker shell entry) is served with `security.csp: false` and the static rules carry no policy — so no response carries two policies. All other Hypdriv headers stay. Without that switch the stage would still defer to Astro's header on on-demand pages (it never overrides an application policy), but prerendered pages would get a second, header-delivered policy.

## Limitations

- Prerendered pages get the request stages on Cloudflare through the Worker shell and on Vercel through Hypdriv's Routing Middleware, which the build scopes to exactly those pages (`hypdriv({ vercel: { middleware: false } })` turns it off). On Node standalone and Cloudflare without the shell they carry static headers only, so rate limits, the bot shield, maintenance mode and per-request ids apply to on-demand routes only.
- Unmatched URLs answered by a prerendered `404.astro` bypass middleware; add the `src/fetch.ts` wrapper (Node, Cloudflare adapter entry) or use the Worker shell. On Vercel they never reach the function; the catch-all route serves `404.html` with its static policy.
- With `trailingSlash: 'always'` Astro redirects `/_hypdriv/health` to `/_hypdriv/health/` before middleware; request the trailing-slash form or use the `src/fetch.ts` wrapper.
- `<ClientRouter />` (view transitions) keeps the first document's policy while it swaps pages, and inline scripts of later pages carry nonces that policy does not list. Astro's own CSP does not support `<ClientRouter />` either; use full navigations on pages that rely on inline scripts.
- Vercel `middlewareMode: 'edge'` moves Astro middleware into an edge function that `/_server-islands/*` bypasses; Hypdriv is built and verified for the default `classic` mode.
- Per-route Early Hints for on-demand pages come from Astro's SSR manifest (external stylesheets and module scripts); assets Astro inlines need none.

# Hypdriv on Waku

[Waku](https://waku.gg) is a minimal React Server Components framework on Vite (`@vitejs/plugin-rsc`): a file router (`src/pages`), a programmatic router (`createPages`), server functions, `_api` route handlers and prerendering. `@hypdriv/waku` runs Hypdriv's Drivetrain around every request Waku answers on Cloudflare Workers, Vercel and Node, and builds the Hypdriv manifest from the Waku build. It follows the Vite host recipe of [ADR 0019](../adr/0019-vite-hosts.md) and the design in [ADR 0021](../adr/0021-waku-host.md). The runnable example is [`examples/waku`](../../examples/waku).

Requirements: `waku >=1.0.0-rc.4 <2` (the 1.0 release candidates; Waku's adapter API is `unstable_`-prefixed, so `hypdriv doctor` reports the pre-release as information), Vite 8, Node 22.15+.

## Install

```sh
pnpm add @hypdriv/waku @hypdriv/core
pnpm add -D @cloudflare/vite-plugin wrangler   # Cloudflare only
```

Add `hypdriv.config.ts` next to `waku.config.ts` (see [configuration](./configuration.md)), then wrap Waku's config:

```ts
// waku.config.ts
import { withHypDriv } from '@hypdriv/waku';
import { defineConfig } from 'waku/config';

export default defineConfig(withHypDriv({}));
```

That is the whole integration. `withHypDriv()` selects the Hypdriv adapter of the build's target (`unstable_adapter`, unless you set one) and adds the Hypdriv Vite plugin; no `src/waku.server.tsx`, no middleware file and no change to your pages is needed. `hypdriv init` does this for an existing app and `npm create hypdriv@latest -- --framework waku` scaffolds a complete one (`examples/waku`).

The target is, in this order: `HYPDRIV_TARGET` (`cloudflare`, `vercel`, `node`), Cloudflare when `@cloudflare/vite-plugin` is among `vite.plugins`, Vercel when `VERCEL=1`, Cloudflare when `CLOUDFLARE` or `WORKERS_CI` is set, else Node. On other platforms (Netlify) `withHypDriv()` leaves Waku's own adapter alone. Request helpers for server code come from `@hypdriv/waku/server` (below).

## How it works

**The adapter.** `@hypdriv/waku/adapters/node|vercel|cloudflare` call the matching Waku adapter (`waku/adapters/*`) with your handlers and options and return its server entry with `fetch` behind `createHandler({ runner: 'host' })` from `@hypdriv/runtime`. Everything else in the entry (`build`, `buildEnhancers`, `serve`, the platform output) is Waku's. Every request the entry answers passes the Drivetrain: pages, RSC payloads, server functions, `_api` routes and static files.

- the HTTPS upgrade, security headers, CSP, rate limiting, the bot shield, geo, flags, redirects, maintenance, the edge cache, Early Hints, logging, tracing and `Server-Timing`;
- Hypdriv's internal routes (`/_hypdriv/health`, CSP reports, vitals, live polling, DevTools endpoints);
- `hyp()` in server components, server functions and `_api` routes (`AsyncLocalStorage`).

**The build.** After the complete build — Waku's static generation and the platform's output included — the plugin writes `.hypdriv/manifest.json` (and `report.md`): the routes of `src/pages` and the literal `createPage` / `createApi` calls of `src/waku.server.*`, the Waku build id, hashed client assets and Early Hints, the CSP hashes of every prerendered page, Purser verification, the secrets scan and budgets. It then patches the final manifest into every server output (the manifest embedded in the server bundle is built before static generation) and writes the platform's static layer. Budget, Purser or secrets failures fail the build. Waku generates its static files by calling its own adapter, so prerendered HTML is Hypdriv-free (no nonce, no request facts) and the build hashes it.

**Routes.** `src/pages` follows Waku's file router: `_api/` handlers (the directory name is stripped, `_api/hello.ts` answers `/hello`), `_layout`, `_root`, `_slices`, `_interceptors`, `(group)` folders removed, `[slug]` and `[...wild]` kept. `export const getConfig = async () => ({ render: 'static' | 'dynamic' })` decides the classification: a `static` page is prerendered (a static slug page only with `staticPaths`); everything else renders per request. A computed `createPage` path cannot be read from the source; list those routes in the plugin's `routes` option (`withHypDriv({}, { routes: [{ pathname: '/docs/[...slug]', kind: 'page' }] })`). They are served and protected either way; only their classification falls back to "rendered per request".

## Classification and CSP

| Route | When | CSP |
| --- | --- | --- |
| `static` | prerendered (`render: 'static'`, or a slug page with `staticPaths`) | hash policy of the built document (`x-hypdriv-csp: hash`), applied by the platform's static headers where the platform serves the file and by the pipeline otherwise |
| `dynamic` | `render: 'dynamic'`, slug pages without `staticPaths`, everything the server renders | nonce policy; the nonce is injected into every `<script>` and `<style>` of the streamed HTML (`HTMLRewriter` on Workers, a streaming injector elsewhere) |
| `route` | `_api` handlers and `createApi` | the route's own headers |

A policy the application sets itself (a `Content-Security-Policy` header from an `_api` route or `createApi` handler) wins: the csp stage reports `x-hypdriv-csp: app` and leaves it alone. Waku inlines the RSC payload as `<script>` tags in every document, so a prerendered page's hash policy covers exactly those inline scripts (the build hashes them) and `'unsafe-inline'` is kept only as the fallback CSP 3 browsers ignore. Use `nonce()` (or `hyp()?.nonce`) for scripts the application renders itself.

## Server helpers

```tsx
// src/pages/dynamic.tsx
import { flag, geo, hyp, nonce } from '@hypdriv/waku/server';

export default async function Page() {
  const context = hyp(); // requestId, nonce, flags, geo, locale, runner, route, env, waitUntil…
  return <p>{context?.flag('newHero', false) ? 'New hero' : 'Classic'}</p>;
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
```

`hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler` are re-exported from `@hypdriv/runtime`. Call them while Waku renders a request — in server components, server functions and `_api` handlers — not from client components, which render in a separate environment. Outside a request (the build-time prerender) `hyp()` returns `null`, so a page that reads it must be `render: 'dynamic'`. `defer()` keeps work alive after the response; `jobHandler()` guards the endpoints `jobs.cron` / `jobs.queues` dispatch to (see [jobs](./jobs.md)).

## Managed and explicit mode

Waku's **managed mode** (no `src/waku.server.*`) is what `withHypDriv()` serves: Waku's virtual server entry loads the adapter `unstable_adapter` names. Nothing else is needed on any target.

With your own **`src/waku.server.tsx`** (Waku's explicit mode), import the Hypdriv adapter instead of Waku's; the options of Waku's adapter keep working, and Hypdriv's go under `hypdriv`:

```tsx
// src/waku.server.tsx
import adapter from '@hypdriv/waku/adapters/node'; // …/vercel, …/cloudflare
import { fsRouter } from 'waku';

export default adapter(fsRouter(import.meta.glob('./pages/**/*.{tsx,ts}')), {
  hypdriv: { host: 'waku' }, // createHandler options: stages, onError, a config or manifest override…
});
```

On Cloudflare the entry is also the Worker's `main`, so it exports the Durable Object classes Hypdriv's rate limits, tag index and live channels use:

```tsx
import adapter from '@hypdriv/waku/adapters/cloudflare';
import { fsRouter } from 'waku';

export * from '@hypdriv/waku/durable-objects'; // HypDrivLimiter, HypDrivIndex, HypDrivChannel

export default adapter(fsRouter(import.meta.glob('./pages/**/*.{tsx,ts}')));
```

Production builds export the classes from the Worker entry by themselves (the plugin appends them to Waku's server entry), so exporting them from your file as well is harmless. `waku dev` and `wrangler dev` load your file as the Worker, where the export is what makes the bindings resolve. Turn the automatic export off with `withHypDriv({}, { durableObjects: false })` when you export your own classes.

## Node

```sh
HYPDRIV_TARGET=node waku build   # the default without a Cloudflare plugin or VERCEL=1
waku start                        # first free port from 8080; --port or PORT and --host or HOST override
node dist/serve-node.js           # the same server, port 3000 unless PORT is set
```

- Waku's Node adapter is a Hono app that serves `dist/public` and then renders. The Hypdriv adapter wraps that app's `fetch`, so prerendered pages, RSC payloads and public files pass the pipeline like everything else: they get the request stages and their hash policies, and content-hashed assets (`/assets/*`) get `Cache-Control: public, max-age=31536000, immutable`, which Waku's static server does not set.
- The client address is the socket address unless `security.trustedProxies` is greater than zero: behind a proxy or load balancer set it to the number of proxies so the forwarded headers decide, or IP-keyed rate limits share the proxy's bucket.
- No platform services are needed; capabilities that need one (Durable Objects, Vercel CDN tags) report their baseline behaviour.

## Cloudflare Workers

Add `@cloudflare/vite-plugin` for Waku's `rsc` and `ssr` environments (Waku's Cloudflare guide), and keep a `wrangler.jsonc` with the assets binding, the worker-first rule and the Durable Objects:

```ts
// waku.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { withHypDriv } from '@hypdriv/waku';
import { defineConfig } from 'waku/config';

export default defineConfig(
  withHypDriv({
    vite: { plugins: [cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })] },
  }),
);
```

```jsonc
// wrangler.jsonc
{
  "name": "my-waku-app",
  "main": "./src/waku.server",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist/public",
    "binding": "ASSETS",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": ["/*", "!/assets/*"]
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

`withHypDriv()` adds the environment settings Waku's Cloudflare setup needs (`hono/tiny` and `rsc-html-stream` pre-bundled for the Worker, platform-neutral server bundles) and fails with the line to add when the Cloudflare plugin is missing from a Cloudflare build. `main` stays `./src/waku.server` even without that file: in managed mode a virtual entry stands in for it in development, and Waku's build writes the deployable configuration to `dist/server/wrangler.json`.

- **Hypdriv's Worker shell.** The Worker's default export is `createWorker()` around Waku's: the full Drivetrain with `runner: 'worker'` (`HTMLRewriter`, Durable Object rate limits and tag index when bound), Hypdriv's `scheduled`, `queue` and `email` dispatchers next to the `handlers` you pass to Waku's adapter (Hypdriv's take the events configured in `jobs`, yours take the rest), and `tail`.
- **Worker first.** `run_worker_first: ["/*", "!/assets/*"]` sends every request but the content-hashed assets through the Worker. For GET and HEAD the Worker asks the `ASSETS` binding first, so prerendered pages, RSC payloads and public files are served as built — with the request stages (rate limits, bot shield, maintenance, redirects, flags) and their hash policies applied — and anything else is rendered by Waku. Workers Static Assets answer `/assets/*` before the Worker; `hypdriv audit https` checks that plain-HTTP asset requests are redirected, which needs HTTPS redirection in the zone (see [production Cloudflare](./production-cloudflare.md)).
- **Static headers.** The plugin merges Hypdriv's rules (security preset, the immutable rule for `/assets/*`, the documents' hash policies, Early Hints) into `dist/public/_headers` and keeps `.vite` and `.hypdriv` out of the upload.
- **The build request.** Waku's Cloudflare build generates its static files by calling its adapter with a request to `/__waku_internal_build_static_files` on a loopback host. The shell hands that request to Waku directly (a loopback host and no `cf-visitor` header, which every production request carries), so the generated HTML carries no nonce or request facts.
- **Account-specific configuration** stays in a git-ignored `wrangler.<name>.local.jsonc` that you pass to `cloudflare({ configPath })`; `examples/waku` reads it from `WRANGLER_CONFIG`.

Build with `HYPDRIV_TARGET=cloudflare waku build` (or a build where the Cloudflare plugin is configured), run locally with `wrangler dev --config dist/server/wrangler.json`, deploy with `wrangler deploy --config dist/server/wrangler.json`. `waku dev` runs the Worker in workerd through the Cloudflare plugin.

## Vercel

```sh
VERCEL=1 waku build     # or HYPDRIV_TARGET=vercel; Vercel's build command is `waku build`
```

Waku's Vercel adapter writes the Build Output API (`.vercel/output`) with one function (`RSC.func`) behind a catch-all route; Hypdriv wraps that function's `fetch` and adds, after the build:

- **Static pages at clean URLs.** The prerendered documents in `.vercel/output/static` are mapped with Build Output `overrides` (`about/index.html` is served at `/about`), so the CDN answers them without invoking the function, with Hypdriv's static header rules and their hash CSP.
- **Routing Middleware for those pages.** Hypdriv's prerender-scoped middleware (GET/HEAD, only the prerendered paths) runs the request stages — rate limits, the bot shield, maintenance, redirects, geo — for documents the CDN would otherwise serve untouched. Turn it off with `withHypDriv({}, { vercelMiddleware: false })`.
- **The function** receives everything else — dynamic pages, RSC payloads, server functions, `_api` routes — and runs the pipeline once, with Vercel's platform wiring: the Vercel CDN stage owns the function's cache headers, tag purges go to Vercel, Upstash / Global Config / WAF / BotID when configured.
- The function's embedded manifest and `.hypdriv/manifest.json` are the final ones (the build warns when no server output embeds it, which means the Hypdriv adapter is not selected).

## Development

`waku dev` runs the same adapter on Node (and in workerd with the Cloudflare plugin): CSP nonces, `hyp()`, flags, rate limits and `/_hypdriv/*` behave as in production, with `'unsafe-eval'` and the HMR WebSocket allowed in the CSP when `NODE_ENV` is `development`.

## Options

`withHypDriv(config, options)`, or `hypdriv(options)` from `@hypdriv/waku` when you configure `unstable_adapter` and `vite.plugins` yourself:

| Option | Default | Purpose |
| --- | --- | --- |
| `config` | `hypdriv.config.*` in the project root | a path or an inline Hypdriv config |
| `target` | detected (above) | `cloudflare`, `vercel` or `node` |
| `srcDir` | Waku's `srcDir` (`src`) | where `pages/` and `waku.server.*` live |
| `routes` | none | extra routes, or a function that returns the final list |
| `vercelMiddleware` | `true` | Hypdriv's Routing Middleware for the CDN's prerendered pages |
| `durableObjects` | `true` | export the Durable Object classes from the Worker entry |

The adapter functions take Waku's own adapter options plus `hypdriv: { … }`: the `createHandler` options (`stages`, `onError`, a `config` or `manifest` override) and, on Cloudflare, `assets` (the static-assets binding name, `false` to send everything to Waku).

## Limitations

- Waku is a release candidate and its adapter builders are `unstable_`: the peer range is pinned to `>=1.0.0-rc.4 <2` and `build.test.ts` runs Waku's real Node and Vercel builds, so a change in Waku fails the tests instead of production.
- Routes with computed `createPage` paths need the `routes` option for classification; protection does not depend on it.
- Hypdriv's Node server for Vite hosts (`hypdriv serve`) is not used: `waku start` and `dist/serve-node.js` are Waku's, wrapped by the adapter.
- Verified locally with a real Node server, workerd (`wrangler dev` on the built `dist/server/wrangler.json`, and `waku dev`), a real `vercel build` and the Vercel routing emulated in process. Live Cloudflare and Vercel deployments, the Vercel CDN's own behaviour and edge purges on a real zone need a deployment (`e2e/hosts`).

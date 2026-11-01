# Hypdriv on SolidStart

[SolidStart 2](https://docs.solidjs.com/solid-start/v2) is Solid's meta-framework on Vite 8: file routes (`src/routes`), API routes, server functions (`"use server"`), streaming server rendering and — through Nitro — prerendering. It builds for a platform with a **deployment plugin**: Nitro 3 (`nitro/vite`) or `@cloudflare/vite-plugin`. `@hypdriv/solid-start` runs Hypdriv's Drivetrain around every request SolidStart answers on Cloudflare Workers, Vercel and Node, and builds the Hypdriv manifest from the SolidStart build. It follows the Vite host recipe of [ADR 0019](../adr/0019-vite-hosts.md) and the design in [ADR 0024](../adr/0024-solid-start-host.md). The runnable example is [`examples/solid-start`](../../examples/solid-start).

Requirements: `@solidjs/start >=2.0.0 <3` (SolidStart 1, which builds with Vinxi and `app.config.ts`, is not supported: `hypdriv doctor` says so), Vite 8, Node 22.12+ for Hypdriv's packages. SolidStart 2 itself declares Node 24 and Nitro 3 needs 22.22+; the example was verified on 22.23.

## Install

```sh
pnpm add @hypdriv/solid-start @hypdriv/core
pnpm add -D @cloudflare/vite-plugin wrangler   # Cloudflare (Hypdriv's Worker shell) only
```

Add `hypdriv.config.ts` next to `vite.config.ts` (see [configuration](./configuration.md)), register the plugin **after** `solidStart()` and the deployment plugin, and give Solid the request's nonce:

```ts
// vite.config.ts
import { hypdriv } from '@hypdriv/solid-start/vite';
import { solidStart } from '@solidjs/start/config';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    solidStart(),
    nitro({ preset: 'node-server' }), // 'vercel' on Vercel; see Cloudflare below
    hypdriv(),
  ],
  nitro: { prerender: { routes: ['/', '/about'] } },
});
```

```tsx
// src/entry-server.tsx
import { hypdrivStart } from '@hypdriv/solid-start';
import { createHandler, StartServer } from '@solidjs/start/server';

export default createHandler(
  () => <StartServer document={/* your document */} />,
  hypdrivStart(), // the request's CSP nonce on every inline script Solid renders
);
```

```ts
// src/global.d.ts — types of virtual:hypdriv/config and virtual:hypdriv/manifest
/// <reference types="@hypdriv/solid-start/virtual" />
```

That is the whole integration on Node and Vercel: no middleware file and no change to your routes. `hypdriv init` does this for an existing app and `npm create hypdriv@latest -- --framework solid-start` scaffolds a complete one (`examples/solid-start`).

The deployment target is chosen by the deployment plugin you list (`HYPDRIV_TARGET` in the example's `vite.config.ts` picks between them): `@cloudflare/vite-plugin` means Cloudflare, Nitro's preset means `vercel`, `cloudflare-*` or Node. Pass `hypdriv({ targets: ['vercel'] })` to override.

## How it works

**Nitro (Node, Vercel, a Nitro-built Worker).** `hypdriv()` carries a Nitro module. Nitro installs it, and it registers a runtime plugin that wraps `nitroApp.fetch` — the one function every request of every preset passes through — with `createHandler({ runner: 'host' })` from `@hypdriv/runtime`. SolidStart's H3 app runs inside it, so the pipeline owns the whole response: the HTTPS upgrade, security headers, CSP, rate limiting, the bot shield, geo, flags, redirects, maintenance, the edge cache, Early Hints, logging, tracing and `Server-Timing`; `/_hypdriv/health`, CSP reports and the other internal routes; and the documents Nitro serves from its public directory on Node. Content-hashed assets (`/_build/assets/*`) and media skip the pipeline: their headers are static.

Nitro's **prerender build never runs the pipeline**: the module skips Nitro's prerender instance, so static documents contain no request's nonce, id or flags, and the build fails if one does. Keep `hypdriv()` after `nitro()` in the plugin list.

**Cloudflare with `@cloudflare/vite-plugin`.** SolidStart's `entry-server` is not a Worker entry. The Worker's `main` is a file of yours that wraps it in Hypdriv's shell (below).

**The build.** After the complete build — client and server environments, Nitro's server build and its prerendering — the plugin writes `.hypdriv/manifest.json` (and `report.md`): the routes of `src/routes`, the per-route client assets, hashed assets and Early Hints, the CSP hashes of every prerendered page, Purser verification, the secrets scan and budgets. It then patches the final manifest into every server output (`dist/server`, `.output/server`, `.vercel/output/functions/*.func`; the manifest embedded when the server was bundled predates prerendering) and writes the platform's static layer. Budget, Purser or secrets failures fail the build.

**Routes.** `src/routes` is scanned with SolidStart's conventions: `[id]` → `/posts/[id]`, `[[id]]` optional, `[...rest]` catch-all (names such as `404` are accepted), `(group)` folders removed, `index` files at the folder's path. A page with pages below it is a layout, not a route; a module with HTTP-method exports (`GET`, `POST`, …) and no default export is an API `endpoint`; a module with both is a page. `"use server"` anywhere under `src` adds the `/_server/[[...path]]` endpoint. `solidStart({ appRoot, routeDir, extensions })` is honoured through the plugin's `appRoot`, `routeDir` and `extensions` options. `export * from` in a route module is not followed.

## Classification and CSP

| Route | When | CSP |
| --- | --- | --- |
| `static` | listed in `nitro.prerender.routes` (or found by `crawlLinks`) | hash policy of the built document (`x-hypdriv-csp: hash`), applied by the platform's static headers where the platform serves the file (Cloudflare `_headers`, Vercel routes) and by the pipeline on Node |
| `dynamic` | every other page | nonce policy; Solid renders the nonce itself (`hypdrivStart()`) and the CSP stage injects it into anything left (`HTMLRewriter` on Workers, a streaming injector elsewhere) |
| `route` | API routes, `/_server` | the route's own headers |

Solid's hydration script and the serialised-resource scripts are inline: a prerendered page's hash policy covers exactly the inline scripts of its document (the build hashes them, the live check counts them), and `'unsafe-inline'` stays only as the fallback CSP 3 browsers ignore. In nonce mode `hypdrivStart()` makes Solid stamp the nonce on `HydrationScript`, streamed chunks and the client redirect; without it the response is still protected, by the rewrite. A policy the application sets itself wins (`x-hypdriv-csp: app`).

## Server helpers

```ts
// src/routes/api/time.ts, "use server" functions, route preload / createAsync code on the server
import { flag, hyp } from '@hypdriv/solid-start/server';

export async function GET() {
  return Response.json({ requestId: hyp()?.requestId, hero: flag('newHero', false) });
}
```

`hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler` are re-exported from `@hypdriv/runtime`. Route components also render in the browser, so call them from a `"use server"` function that the component invokes (the example's `src/request-facts.ts`); in the browser the entry resolves to stand-ins that report "no request". Outside a request (the build-time prerender) `hyp()` returns `null`, so a page that reads it must not be prerendered. `defer()` keeps work alive after the response; `jobHandler()` guards the endpoints `jobs.cron` / `jobs.queues` dispatch to (see [jobs](./jobs.md)).

## Node

```sh
vite build                        # with nitro({ preset: 'node-server' })
node .output/server/index.mjs     # PORT, HOST
```

- Nitro's server answers prerendered pages from its public-asset table inside `nitroApp.fetch`, so they pass the pipeline: request stages and the hash policy from the manifest. Hashed assets are served with the static rules through Nitro `routeRules` (`/_build/assets/**`).
- The client address is the socket address unless `security.trustedProxies` is greater than zero: behind a proxy or load balancer set it to the number of proxies so the forwarded headers decide, or IP-keyed rate limits share the proxy's bucket.
- Nitro's server publishes `/.vite/manifest.json` from its public directory; the wrapper answers `404` for `/.vite/*` and `/.hypdriv/*`.

## Vercel

```sh
VERCEL=1 vite build     # Nitro's `vercel` preset; Vercel's build command is `vite build`
```

Nitro's Vercel preset writes the Build Output API (`.vercel/output`) with one function; Hypdriv wraps its `fetch` and adds, after the build:

- **Static pages at clean URLs.** The prerendered documents in `.vercel/output/static` are mapped with Build Output `overrides` (`about/index.html` is served at `/about`), so the CDN answers them without invoking the function, with Hypdriv's static header rules and their hash CSP.
- **Routing Middleware for those pages.** Hypdriv's prerender-scoped middleware (GET/HEAD, only the prerendered paths) runs the request stages — rate limits, the bot shield, maintenance, redirects, geo — for documents the CDN would otherwise serve untouched. Turn it off with `hypdriv({ vercelMiddleware: false })`.
- **The function** receives everything else — rendered pages, server functions, API routes — and runs the pipeline once, with Vercel's platform wiring (the Vercel CDN stage owns cache headers, tag purges go to Vercel, Upstash / Global Config / WAF / BotID when configured).

## Cloudflare Workers

Two builds exist; the first is the recommended one and the one `examples/solid-start` and `hypdriv init` use.

### `@cloudflare/vite-plugin` and Hypdriv's Worker shell

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/solid-start/vite';
import { solidStart } from '@solidjs/start/config';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [solidStart(), cloudflare({ viteEnvironment: { name: 'ssr' } }), hypdriv()],
});
```

```ts
// src/worker.ts — wrangler `main`
/// <reference types="@hypdriv/solid-start/virtual" />
import config from 'virtual:hypdriv/config';
import { createSolidStartWorker } from '@hypdriv/solid-start/cloudflare';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

export default createSolidStartWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  entry: () => import('./entry-server'),
});
```

```jsonc
// wrangler.jsonc
{
  "name": "my-solid-start-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "run_worker_first": ["/*", "!/_build/assets/*"] },
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

- **The Worker entry is yours.** `createSolidStartWorker()` is `createWorker()` around SolidStart: the full Drivetrain with `runner: 'worker'` (`HTMLRewriter`, Durable Object rate limits and tag index when bound), Hypdriv's `scheduled`, `queue` and `email` dispatchers (jobs call your job endpoints with signed requests) and `tail`. Do not point `main` at `src/entry-server.tsx`: it is SolidStart's entry, not a Worker (`solid-start.worker-entry` fails on it). Pass the entry as `entry: () => import('./entry-server')`; the `@solidjs/start/server/entry` alias would make Vite load the module twice.
- **Worker first.** `run_worker_first: ["/*", "!/_build/assets/*"]` sends every request but the content-hashed assets through the Worker. For GET and HEAD the Worker asks the `ASSETS` binding first, so public files are served as built — with the request stages applied — and anything else is rendered by SolidStart. Workers Static Assets answer `/_build/assets/*` before the Worker; `hypdriv audit https` checks plain-HTTP asset requests, which needs HTTPS redirection in the zone (see [production Cloudflare](./production-cloudflare.md)).
- **Bindings.** `env` and `ctx` reach SolidStart on the request as srvx provides them everywhere: `getRequestEvent()?.nativeEvent.req.runtime?.cloudflare?.env`.
- **Every page renders per request.** SolidStart prerenders only through Nitro, so on this path there are no static documents: the pages get a nonce-based CSP and the edge cache stage's policies. The build still writes `dist/client/_headers` (security preset, immutable assets, Early Hints) and patches the final manifest into `dist/server`.
- **Account-specific configuration** stays in a git-ignored `wrangler.<name>.local.jsonc` that you pass to `cloudflare({ configPath })`; the example reads `WRANGLER_CONFIG`.
- **Development.** `vite dev` runs the Worker in workerd. Pre-bundle Solid for the `ssr` environment (`environments.ssr.optimizeDeps.include: ['solid-js', 'solid-js/web', 'solid-js/store', '@solidjs/router', '@solidjs/start/fns/server']`, as the example does), or the dependency optimiser finds it on the first request and reloads the Worker under it, which fails that render.

Build with `HYPDRIV_TARGET=cloudflare vite build`, run locally with `wrangler dev -c dist/server/wrangler.json` (`vite preview` does not run a SolidStart build) and deploy with `wrangler deploy`.

### Nitro's `cloudflare_module` preset

`nitro({ preset: 'cloudflare_module' })` builds the Worker itself and prerenders (`nitro.prerender.routes`): prerendered pages are static assets with the hash policy from `_headers`, everything else renders in the Worker behind the Nitro runtime plugin, with the pipeline running in the Worker. Set `nodejs_compat` and a `compatibility_date` your runtime supports in Nitro's Cloudflare configuration (Nitro writes today's date into `.output/server/wrangler.json` otherwise). Hypdriv's Worker shell is not part of this build, so Durable Object stores, the `scheduled` / `queue` / `email` handlers and worker-first public files need the first path.

## Development

`vite dev` runs the same pipeline (Nitro's dev server, or workerd with the Cloudflare plugin): CSP nonces, `hyp()`, flags, rate limits and `/_hypdriv/*` behave as in production, with `'unsafe-eval'` and the HMR WebSocket allowed in the CSP while developing.

## Options

`hypdriv(options)` from `@hypdriv/solid-start/vite`:

| Option | Default | Purpose |
| --- | --- | --- |
| `config` | `hypdriv.config.*` in the project root | a path or an inline Hypdriv config |
| `targets` | detected (above) | `cloudflare`, `vercel` and/or `node` static configuration to write |
| `appRoot`, `routeDir`, `extensions` | `./src`, `./routes`, none besides `js` `jsx` `ts` `tsx` | the values you pass `solidStart()`, when they are not the defaults (read from it when it exposes them) |
| `vercelMiddleware` | `true` | Hypdriv's Routing Middleware for the CDN's prerendered pages |
| `nitroPlugin` | the package's `@hypdriv/solid-start/nitro` | a replacement Nitro runtime plugin file |

`createSolidStartWorker(options)` takes `createWorker()`'s options (`config`, `manifest`, `handlers`, `stages`, …) plus `entry` and `assets` (the static-assets binding name, `false` to send everything to SolidStart).

## Tooling

- `hypdriv init` registers `hypdriv()` in `vite.config`, passes `hypdrivStart()` to `createHandler()`, and on Cloudflare adds the Cloudflare plugin, `src/worker.ts` and the wrangler settings; edits it cannot place safely are printed.
- `hypdriv doctor` adds `solid-start.version`, `.deployment-plugin`, `.plugin-order`, `.cloudflare-plugin`, `.worker-entry`, `.entry-nonce` and `.prerender` to the shared Vite-host checks.
- `hypdriv routes`, `manifest` and `audit` work from `.hypdriv/manifest.json` as on the other hosts.
- `npm create hypdriv@latest -- --framework solid-start --platform cloudflare|vercel|node`.
- `pnpm -F @hypdriv/e2e-hosts check --url … --framework solid-start --static / --static /about --dynamic /request --dynamic /posts/hello --api /api/time --rate-limit 60` verifies a running or deployed app.

## Limitations

- SolidStart 2 and Nitro 3 are young (Nitro is a release candidate): the peer range is `@solidjs/start >=2.0.0 <3`, and `build.test.ts` runs real builds for Vercel, Node and Nitro's Cloudflare preset, so a change in either fails the tests instead of production.
- Pages are `static` (prerendered by Nitro) or `dynamic`; route rules (`routeRules`, ISR) are not classified. On `@cloudflare/vite-plugin` nothing is prerendered.
- Route discovery reads sources lexically: a computed or re-exported route module (`export *`) is not seen. Protection does not depend on it; classification and CSP mode fall back to "rendered per request".
- Netlify and the static preset are not Hypdriv targets; Nitro presets other than Vercel and Cloudflare are treated as Node.
- Verified locally with a real Node server, workerd (`wrangler dev` on the built Worker, and `vite dev`), a real offline `vercel build` and the Vercel routing emulated in process. Hydration in a browser, live Cloudflare and Vercel deployments, the Vercel CDN's own behaviour and edge purges on a real zone need a deployment (`e2e/hosts`).

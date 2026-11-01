# Hypdriv on RedwoodSDK

[RedwoodSDK](https://rwsdk.com) (`rwsdk`) is a React Server Components framework for Cloudflare Workers, built as a Vite plugin: the application is a Worker module whose default export is `defineApp([...])`, with `route()`, `index()`, `prefix()`, `layout()` and `render()` entries, server components, server functions and a client entry. `@hypdriv/rwsdk` runs Hypdriv's Drivetrain around every request that Worker answers, and builds the Hypdriv manifest from the RedwoodSDK build. It follows the Vite host recipe of [ADR 0019](../adr/0019-vite-hosts.md) and the design in [ADR 0025](../adr/0025-rwsdk-host.md). The runnable example is [`examples/rwsdk`](../../examples/rwsdk).

Not RedwoodJS: the package is named after the npm dependency (`rwsdk`), and Hypdriv's health route and CLI call the framework "RedwoodSDK".

Requirements: `rwsdk >=1.0.0 <2`, Vite 8, `@cloudflare/vite-plugin`, Node 22.12+. RedwoodSDK builds for Cloudflare Workers only, so that is the only platform of this host.

## Install

```sh
pnpm add @hypdriv/rwsdk @hypdriv/core
pnpm add -D @cloudflare/vite-plugin wrangler
```

Add `hypdriv.config.ts` next to `vite.config.mts` (see [configuration](./configuration.md)), register the plugin after `redwood()`, and wrap the app:

```ts
// vite.config.mts
import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/rwsdk';
import { redwood } from 'rwsdk/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  environments: { ssr: {} },
  plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()],
});
```

```tsx
// src/worker.tsx
import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
import { render, route } from 'rwsdk/router';
import { defineApp } from 'rwsdk/worker';
import { Document } from '@/app/Document';
import { Home } from '@/app/pages/Home';

export default withHypDriv(
  defineApp([
    hypdrivMiddleware(), // first: RedwoodSDK renders with the nonce of Hypdriv's CSP
    render(Document, [route('/', Home)]),
  ]),
);
```

That is the whole integration: no change to your pages, your `Document` or your client entry. `hypdriv init` does it for an existing app (wraps `defineApp`, puts `hypdrivMiddleware()` first, adds the plugin last, writes the Wrangler settings) and `npm create hypdriv@latest -- --framework rwsdk` scaffolds a complete one (`examples/rwsdk`).

A config that does not declare `@cloudflare/vite-plugin` keeps working: RedwoodSDK registers the plugin itself (with the same `worker` environment). Declare it, as above, when you want one Wrangler config you control, for example an account-specific `wrangler.<name>.local.jsonc` selected with `cloudflare({ configPath })`. A declared plugin must name the `worker` environment and the config must declare `environments: { ssr: {} }`; `hypdriv doctor` checks both.

## How it works

**The wrapper.** `withHypDriv(app)` returns the Worker object your entry exports: the `fetch` of `createWorker()` (`@hypdriv/cloudflare`) around RedwoodSDK's own, with everything else of `defineApp`'s result kept (`__rwRoutes`, so `defineLinks<typeof app>()` still types your links). Every request the Worker receives passes the Drivetrain:

- the HTTPS upgrade, security headers, CSP, rate limiting, the bot shield, geo, flags, redirects, maintenance, the edge cache, Early Hints, logging, tracing and `Server-Timing`;
- Hypdriv's internal routes (`/_hypdriv/health`, CSP reports, vitals, live polling, DevTools endpoints);
- `hyp()` in server components, server functions and route handlers (`AsyncLocalStorage`).

`HTMLRewriter`, the Durable Object stores (rate limits, tag index, live channels, when bound) and `scheduled`, `queue`, `email` and `tail` handlers come with the Worker shell: Hypdriv's dispatchers take the events configured in `jobs` (cron triggers, the queues `jobs.queues` consumes, email when `jobs.email` is set); the handlers on your own app object take the rest, and a failure of either is raised after both ran.

**Static files first.** `wrangler.jsonc` sends every request but RedwoodSDK's content-hashed assets through the Worker (`run_worker_first: ["/*", "!/assets/*"]`). For GET and HEAD the wrapper asks the `ASSETS` binding before RedwoodSDK, so files in `public/` (`robots.txt`, images, `favicon`) are served as built — with the request stages and security headers applied — and everything else is rendered by RedwoodSDK. Workers Static Assets answer `/assets/*` before the Worker; `hypdriv audit https` checks that plain-HTTP requests for a hashed asset are redirected, which needs HTTPS redirection in the zone (see [production Cloudflare](./production-cloudflare.md)).

**The build.** RedwoodSDK builds in several passes (the Worker, the SSR bridge, the client and a linker). After the last one the plugin writes `.hypdriv/manifest.json` (and `report.md`): the routes, the client entry chunks and hashed assets (Early Hints, budgets), Purser verification and the secrets scan. It then patches the final manifest into the built Worker (`dist/worker`) and writes `dist/client/_headers` with the security preset, the immutable `Cache-Control` of the hashed assets and the Early Hints. Budget, Purser or secrets failures fail the build. The build prints a warning when the Worker entry does not use `withHypDriv()`, when its `defineApp` has no `hypdrivMiddleware()`, and when it could not read all of the routes.

**Durable Objects.** Hypdriv's rate limiter, tag index and live channels are Durable Object classes that the Worker entry must export. The plugin appends the export to the entry RedwoodSDK builds (the Wrangler config's `main`, else `src/worker.tsx`, else the `entry` option), so the bindings in `wrangler.jsonc` resolve without an export of your own. Turn it off with `hypdriv({ durableObjects: false })` and `export * from '@hypdriv/rwsdk/durable-objects'` from your entry when you export your own classes.

## The CSP nonce

RedwoodSDK renders inline scripts in every document — the RSC payload and the hydration bootstrap — and gives each one a nonce it generates per request (`requestInfo.rw.nonce`). Hypdriv's nonce CSP allows the nonce the csp stage issued, which it forwards on the `x-nonce` request header and injects into every tag that does not carry one. A page whose scripts carry RedwoodSDK's own nonce renders, but the browser blocks the scripts and the page never hydrates.

`hypdrivMiddleware()` closes the gap: as the first entry of `defineApp([...])`, it copies Hypdriv's nonce into `rw.nonce`. RedwoodSDK then puts it on its payload and hydration scripts and on the `<script>` tags of your `Document`, so one nonce covers the page; `requestInfo.rw.nonce` (and `nonce()` from `@hypdriv/rwsdk/server`) give you the same value for tags you render yourself:

```tsx
// src/app/Document.tsx: the <script> tags get the request's nonce, no attribute needed
import type { DocumentProps } from 'rwsdk/router';

export const Document = ({ children }: DocumentProps) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <link rel="modulepreload" href="/src/client.tsx" />
    </head>
    <body>
      <div id="root">{children}</div>
      <script>import("/src/client.tsx")</script>
    </body>
  </html>
);
```

Without the middleware the problem is silent on the server, so it is reported three ways: the Worker logs an error once per isolate when an HTML response to a request that had a nonce did not pass the middleware, the build warns when `defineApp` has none, and `hypdriv doctor` fails `rwsdk.nonce-middleware` (it also searches `src/` when your routes live outside the entry file). The check is skipped when CSP is off (`security.csp.mode: 'off'`), since RedwoodSDK's own nonce is then not blocked. The middleware leaves an internal `x-hypdriv-rwsdk` marker on the response, which the wrapper removes before the response leaves the Worker.

## Routes and classification

`defineApp` has no route files, so the Worker reads its routes from the running app: `appRoutes()` flattens `__rwRoutes`, and RedwoodSDK's paths become Hypdriv's patterns — `/users/:id/` is `/users/[id]`, `/files/*` is `/files/[...splat]` (a wildcard before the last segment is `[splat]`). A handler that renders a component is a page; a function that returns a `Response` is a route; a method table (`{ get, post }`) is a page when its `get` renders. These routes are what the pipeline classifies by, so protection and CSP mode never depend on the build.

The build reads the same routes from the Worker's source so that `.hypdriv/manifest.json`, `hypdriv routes` and the budgets have something to show before the Worker runs: the array literals of `defineApp`, the route arrays imported from other files (relative imports and `tsconfig` `paths`), `const`s, spreads and namespace members, with `prefix()`, `layout()` and `render()` nesting applied. A path computed at run time cannot be read statically. The build lists what it could not read; add those routes with the plugin's `routes` option (an array added to the scanned routes, or a function that returns the final list):

```ts
hypdriv({ routes: [{ pathname: '/docs/[...slug]', kind: 'page' }] });
```

| Route | CSP | Notes |
| --- | --- | --- |
| `dynamic` (a page) | nonce policy; the nonce is on every `<script>` and `<style>` of the streamed HTML (`HTMLRewriter`) | every RedwoodSDK page: the framework renders per request, so there are no prerendered documents and no hash policies |
| `route` (an endpoint) | the route's own headers | handlers that return a `Response`, such as `route('/api/ping', { get })` |

A `Content-Security-Policy` header an endpoint sets itself wins: the csp stage reports `x-hypdriv-csp: app` and leaves it alone.

## Server helpers

```tsx
// src/app/pages/Product.tsx
import { hyp } from '@hypdriv/rwsdk/server';
import type { RequestInfo } from 'rwsdk/worker';

export const Product = ({ params }: RequestInfo<{ id: string }>) => {
  const context = hyp(); // requestId, nonce, flags, geo, locale, runner, route, env, waitUntil…
  return <p>{context?.flag('newHero', false) ? 'New' : 'Classic'} product {params.id}</p>;
};
```

`hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler` are re-exported from `@hypdriv/runtime`. Call them while RedwoodSDK handles a request — in server components, server functions (`"use server"`) and route handlers — not from client components, which render in the browser and in the SSR bridge. `defer()` keeps work alive after the response; `jobHandler()` guards the endpoints `jobs.cron` / `jobs.queues` dispatch to (see [jobs](./jobs.md)).

## Cloudflare Workers

```jsonc
// wrangler.jsonc
{
  "name": "my-rwsdk-app",
  "main": "src/worker.tsx",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "run_worker_first": ["/*", "!/assets/*"] },
  "observability": { "enabled": true },
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

The `assets` binding and the worker-first rule are what make public files pass the pipeline; the Durable Object bindings are optional upgrades (exact, global rate limits, the tag index and live channels; without them Hypdriv uses its baseline behaviour, see [Cloudflare](./cloudflare.md)). Account-specific configuration stays in a git-ignored `wrangler.<name>.local.jsonc` that you pass to `cloudflare({ configPath })`; `examples/rwsdk` reads it from `WRANGLER_CONFIG`. Secrets (`HYPDRIV_SESSION_SECRET`, `HYPDRIV_INTERNAL_SECRET`) go in `.dev.vars` locally and `wrangler secret put` in production; see [production Cloudflare](./production-cloudflare.md) for the launch checklist.

```sh
pnpm vite build        # dist/worker (the Worker + wrangler.json) and dist/client (assets + _headers)
pnpm vite preview      # the production Worker in workerd, port 4173
pnpm wrangler deploy   # RedwoodSDK's build points .wrangler/deploy/config.json at dist/worker/wrangler.json
```

## Development

`vite dev` runs the Worker in workerd through the Cloudflare plugin with the same wrapper: CSP nonces, `hyp()`, flags, rate limits and `/_hypdriv/*` behave as in production, and the development endpoints of the DevTools HUD are on.

## Check it

```sh
pnpm hypdriv doctor                                       # integration, nonce middleware, plugin order, Wrangler config
pnpm hypdriv routes                                       # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:4173
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework redwood --dynamic / --api /api/ping
```

`hypdriv doctor` adds `rwsdk.worker-entry` (the entry wraps the app in `withHypDriv()`), `rwsdk.nonce-middleware`, `rwsdk.cloudflare-plugin` (declared on the `worker` environment with `environments: { ssr: {} }`), `rwsdk.plugin-order` (`hypdriv()` after `redwood()`), `rwsdk.platform` and `rwsdk.version` (a pre-release of 1.0.0 or another major) to the shared Vite-host checks. The live checker matches the framework against the health route's label, which is "RedwoodSDK", so the flag is `--framework redwood`.

Under `vite preview` the bot-shield check reports a failure that is not one: the preview proxy marks every request `sec-fetch-mode: cors`, so a `curl` user agent no longer looks like a navigation. `wrangler dev --config dist/worker/wrangler.json` and deployments do not have that artifact.

## Options

`hypdriv(options)` (the Vite plugin, from `@hypdriv/rwsdk`):

| Option | Default | Purpose |
| --- | --- | --- |
| `config` | `hypdriv.config.*` in the project root | a path or an inline Hypdriv config |
| `entry` | the Wrangler `main`, else `src/worker.tsx` | the Worker entry the build reads routes from and exports the Durable Objects from |
| `routes` | none | extra routes, or a function that returns the final list |
| `durableObjects` | `true` | export the Durable Object classes from the Worker entry |

`withHypDriv(app, options)` (from `@hypdriv/rwsdk/worker`; `@hypdriv/rwsdk/wrap` has the same wrapper as `wrapApp(app, { config, manifest, … })` for tests and your own bundling):

| Option | Default | Purpose |
| --- | --- | --- |
| `routes` | `app` | `app` reads the routes `defineApp` registered; `build` uses the build's manifest as it is |
| `assets` | `ASSETS` | the static-assets binding asked first for GET and HEAD; `false` sends everything to RedwoodSDK |
| `stages` | the default pipeline | a list, or a function `(defaults, platform) => Stage[]` |
| `onError` | JSON 500 with the request id | `(error, request, ctx) => Response` for errors the pipeline or RedwoodSDK throws |
| `development` | `NODE_ENV` or localhost | development mode (the DevTools endpoints, verbose timings) |
| `devState` | none | extra state for the DevTools endpoints |
| `config`, `manifest` | from the plugin | overrides, mainly for tests |

## Limitations

- Cloudflare Workers only: RedwoodSDK documents no Node or Vercel target. `hypdriv init` and `hypdriv doctor` say so on another platform, and `create-hypdriv --framework rwsdk` offers Cloudflare only.
- Every page is rendered per request: no prerendered documents, so no hash policies and no static-page header rules beyond the hashed assets.
- `hypdrivMiddleware()` is required while CSP is on and must run before anything reads `rw.nonce` (put it first).
- Routes with paths computed at run time need the `routes` option for the build-time manifest; protection and CSP mode do not depend on it.
- The integration reads three RedwoodSDK internals: the shape `defineApp` returns, the Vite environment names of its build (`worker`, `client`) and `rw.nonce`. The peer range is `>=1.0.0 <2` and `build.test.ts` runs RedwoodSDK's real build and serves it in workerd, so a change in RedwoodSDK fails the tests instead of production.
- Verified locally with a real RedwoodSDK build served in workerd (`vite preview`, `wrangler dev` on the built Wrangler config) and `vite dev`, including a browser run that hydrates under the nonce CSP. Live Cloudflare deployments (colo behaviour, Early Hints at the edge, zone purges, Durable Objects under load), server functions driven from a browser and HMR over the dev WebSocket need a real account or a longer browser session (`e2e/hosts`).

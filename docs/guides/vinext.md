# HypDriv on vinext

[vinext](https://github.com/cloudflare/vinext) is Cloudflare's Vite implementation of the Next.js API: `app/` and `pages/`, Server Components, Route Handlers, Server Actions, `proxy.ts`, `next/*` imports — built by Vite and deployed to Cloudflare Workers, Vercel (through Nitro) or a Node server. `@hypdriv/vinext` runs HypDriv's Drivetrain around every request vinext answers, on all three, and builds the HypDriv manifest from the vinext build.

Requirements: vinext `^1.4`, Vite 8, Node 22+. App Router apps (including hybrid `app/` + `pages/` apps) get the full integration; Pages Router-only apps use the `proxy.ts` mode described at the end.

## Install

```sh
pnpm add @hypdriv/vinext @hypdriv/core
```

Add `hypdriv.config.ts` next to `vite.config.ts` (see [configuration](./configuration.md)), then put `hypdriv()` **after** `vinext()` and the platform plugin:

```ts
// vite.config.ts
import { hypdriv, withHypDrivCache } from '@hypdriv/vinext';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    vinext({ prerender: true, cache: withHypDrivCache() }),
    // cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } }) or nitro({ preset: 'vercel' })
    hypdriv(),
  ],
});
```

No `proxy.ts`, no custom server and no code change in the app is needed: the plugin installs the request hook itself.

`examples/vinext` is a complete app (prerendered pages, a page that renders `hyp()` facts, a rate-limited Route Handler) that builds for all three platforms: `HYPDRIV_TARGET=cloudflare|vercel|node pnpm build`.

## How it works

**The request hook.** vinext's App Router request handler is the default export of its generated RSC entry (`virtual:vinext-rsc-entry`). The plugin resolves that module to a wrapper (`virtual:hypdriv/vinext-hook`) that re-exports the entry and wraps the handler with `createHandler({ runner: 'host' })` from `@hypdriv/runtime`. Every runtime calls that handler — `vinext start`, the standalone server, the Cloudflare Worker, Nitro's Vercel and Node functions, `vite dev` and `vite preview` — so the Drivetrain owns the full response everywhere:

- security headers, CSP, rate limiting, the bot shield, geo, flags, i18n, redirects, maintenance, the edge cache, Early Hints, logging, tracing and `Server-Timing`;
- HypDriv's internal routes (`/_hypdriv/health`, CSP reports, vitals, live polling, DevTools endpoints);
- `hyp()` in Server Components, Route Handlers, Server Actions and `proxy.ts` (AsyncLocalStorage).

vinext serves its content-hashed build assets (`/_next/static/*`) before the handler; public files pass through the hook.

**The build.** After the complete build — vinext's prerender, cache packaging and the platform output included — the plugin writes `.hypdriv/manifest.json` (and `report.md`): routes from `app/` and `pages/` (Next.js conventions: route groups, parallel slots, private folders, intercepting routes, dynamic and catch-all segments, `route.ts`, the `sitemap` / `robots` / `manifest` metadata routes), the vinext build id, client assets and Early Hints, the CSP hashes of prerendered pages the platform serves as built, Purser verification, the secrets scan and budgets. It then patches the final manifest into every server output (the embedded manifest of the server bundle is built before the prerender), writes the platform's static headers and fails the build on budget, Purser or secrets failures.

**vinext's build-time prerender.** vinext prerenders by running the built server (and `proxy.ts`) in Node. The plugin bakes a random per-build token into the server code and puts it into the build's environment, which vinext's prerender servers inherit; a request is a prerender request only when `VINEXT_PRERENDER=1` and that token are both in the process environment. Clients cannot set either, and a deployed server never has the token. Prerender requests go straight to vinext, so prerendered pages are HypDriv-free HTML (no nonce, no request facts) that the build then hashes.

## Classification and CSP

| Route | When | CSP | vinext page cache |
|---|---|---|---|
| `static` | prerendered, never revalidates, no explicit cache tags, and the platform serves the built document byte for byte | hash policy of the built document (`x-hypdriv-csp: hash`) | served as built |
| `isr` | prerendered or `export const revalidate = N`, but the document can change at run time (revalidation, `cacheTag()` / `fetch` tags) or the platform re-renders it | nonce policy; the nonce is **injected** into vinext's cached HTML | kept: the nonce policy is not forwarded to vinext |
| `dynamic` | everything else (pages that call `headers()`, `cookies()`, `hyp()`…) | nonce policy; vinext applies the nonce to its own scripts | not cached (vinext renders nonce documents per request) |

For dynamic pages HypDriv forwards the nonce policy in the request's `Content-Security-Policy` header, which vinext reads (like Next.js) and applies to its bootstrap scripts, module preloads, inline RSC payload scripts and fonts. For `isr` and `static` routes in nonce mode, HypDriv withholds that header so vinext keeps serving from (and filling) its page cache, then injects the nonce into every `<script>` and `<style>` of the cached document (`HTMLRewriter` on Workers, the streaming injector elsewhere). A document with an injected nonce is marked `Cache-Control: private, no-store` so no shared cache hands one nonce to every visitor; HypDriv's own edge cache stores the document before the injection.

Use `nonce()` (or `hyp()?.nonce`) for scripts the application renders itself, for example `<Script nonce={nonce()}>`. A policy the application sets itself (`next.config` `headers()`, a Route Handler) wins: the csp stage reports `x-hypdriv-csp: app` and leaves it alone.

## Server helpers

```ts
import { defer, flag, geo, hyp, jobHandler, nonce, requireHyp } from '@hypdriv/vinext/server';

export default function Page() {
  const context = hyp(); // requestId, nonce, flags, geo, locale, runner, route, env, waitUntil…
  return <p>{context?.flag('newHero', false) ? 'New hero' : 'Classic'}</p>;
}
```

`hyp`, `requireHyp`, `nonce`, `flag`, `geo` and `devtoolsMeta` are dynamic APIs, like `headers()`: calling one marks the render dynamic, so vinext neither prerenders the page nor stores it in its page cache and no visitor ever receives another visitor's request id, nonce or flags. Outside a request (the build-time prerender) `hyp()` returns `null`. `defer()` keeps work alive after the response; `jobHandler()` guards the endpoints `jobs.cron` / `jobs.queues` dispatch to (see [jobs](./jobs.md)).

## Cache purges

`withHypDrivCache()` wraps vinext's `cache` option so `revalidateTag()` and `revalidatePath()` also purge HypDriv's edge cache, or the purger HypDriv registered for the platform (Vercel's CDN):

```ts
import { kvDataAdapter } from '@vinext/cloudflare/cache/kv-data-adapter';
import { workersCacheCdnAdapter } from '@vinext/cloudflare/cache/workers-cache-cdn-adapter';

vinext({ cache: withHypDrivCache({ data: kvDataAdapter(), cdn: workersCacheCdnAdapter() }) });
```

vinext keeps one CDN adapter: the wrapper instantiates yours (or vinext's default) and forwards every member to it, including its build output hooks and capabilities; after its `revalidateTag(tags, durations)` it purges application tags (`products`) as edge-cache policy tags and path tags (`_N_T_/blog`, `_N_T_/blog/page`, `_N_T_/blog/layout`) as the page's `path:` tag and URL, once immediately and once more after two seconds (vinext commits invalidations at the end of the Route Handler or Server Action).

## Node (`vinext start`)

```sh
HYPDRIV_TARGET=node vite build   # target detected: no Cloudflare plugin, no Nitro
vinext start                     # or output: 'standalone' → node dist/standalone/server.js
```

- Prerendered pages are seeded into vinext's page cache and served as built: `static` routes get their hash policy.
- The hook sees the client address only through forwarding headers, exactly like vinext (`VINEXT_TRUST_PROXY`): run the server behind a proxy or load balancer that sets `X-Forwarded-For` and set `security.trustedProxies` to the number of proxies, or IP-keyed rate limits share one bucket.
- `/_next/static/*` is served by vinext with immutable caching, before the hook.

## Cloudflare Workers

Two set-ups, both with `@cloudflare/vite-plugin` and `cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })`:

**HypDriv's Worker shell (recommended).** Own the Worker entry: the shell runs the Drivetrain with `runner: 'worker'` (HTML rewriting, the Cache API edge cache, Durable Object rate limits and tag index) and adds `scheduled`, `queue`, `email` and `tail` handlers; the in-app hook passes through.

```ts
// worker/index.ts
/// <reference types="@hypdriv/vinext/virtual" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { createVinextWorker } from '@hypdriv/vinext/worker';
import handler from 'vinext/server/fetch-handler';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
export * from 'vinext/server/fetch-handler'; // vinext's named entrypoints (multi-stage cache adapters)
export default createVinextWorker({ config, manifest, app: handler });
```

```jsonc
// wrangler.jsonc
{
  "main": "./worker/index.ts",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/client",
    "binding": "ASSETS",
    "html_handling": "none",
    "not_found_handling": "none",
    "run_worker_first": ["/*", "!/_next/static/*", "!/*/_next/static/*"]
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

**vinext's own entry.** With `"main": "vinext/server/fetch-handler"` the hook runs inside the Worker with `runner: 'host'`, `HTMLRewriter` and the bindings of the invocation; Durable Object stores are used when their bindings exist, but the Worker has no `scheduled` / `queue` handlers of HypDriv's.

Build with `vite build`, run locally with `vite preview` or `wrangler dev --config dist/server/wrangler.json`, deploy with `wrangler deploy --config dist/server/wrangler.json` (or `vinext-cloudflare deploy`).

- **Prerendered pages** are served on Workers only through vinext's `staticAssetsAdapter()` (`cache.cdn`), which packages them into Workers Static Assets: the plugin matches the packaged documents by content and gives those routes a hash policy. Without it vinext re-renders prerendered pages per isolate, so they are `isr`.
- **Static headers.** The plugin merges HypDriv's rules into `_headers` in the assets directory (vinext writes a default `_headers` only when none exists; its immutable rule for `/_next/static/*` is kept) and keeps `.vite` / `.hypdriv` out of the upload.
- vinext refuses Node and Nitro builds of a project with a root `wrangler.jsonc`: an app that builds for several platforms keeps the file elsewhere and passes `configPath` to `cloudflare()` (as `examples/vinext` does with `cloudflare/wrangler.jsonc`).

## Vercel (Nitro)

```ts
import { nitro } from 'nitro/vite';
plugins: [vinext({ prerender: true, cache: withHypDrivCache() }), nitro({ preset: 'vercel' }), hypdriv()];
```

Nitro selects the Vercel preset on Vercel builds by itself (`VERCEL=1`); `vite build` writes `.vercel/output`. Set the project's build command to `vite build` and its output directory to `.vercel/output`.

- The Vercel Function runs the hook with Vercel's platform wiring: the Vercel CDN stage owns the cache headers of the function's responses, tag purges go to Vercel, Upstash / Global Config / WAF / BotID when configured.
- **Prerendered pages.** Nitro packages the function before vinext prerenders, so vinext's prerendered HTML is not part of Nitro's output. The plugin copies the pages that never change (no revalidation, no explicit cache tags) into `.vercel/output/static` (with `overrides` so `/about` serves `about.html`) and adds routes before the filesystem that send their RSC navigations (`RSC` header), Server Actions (`Next-Action` header) and non-GET requests to the function. HypDriv's static header routes give those files the security headers and their hash policy. Turn this off with `hypdriv({ vercelStaticPages: false })`; the pages are then rendered by the function (`isr`).
- The function's `.hypdriv/manifest.json` and its embedded manifest are the final ones.

Other Nitro presets (`node-server`, …) work the same way without the static pages: everything vinext renders goes through the hook, and Nitro serves `public/` and `/_next/static/*` itself (without HypDriv's headers).

## Development

`vite dev` runs the hook too (it resolves vinext's hot-reloaded handler per request): CSP nonces, `hyp()`, flags, rate limits and `/_hypdriv/*` behave as in production, with `'unsafe-eval'` and the HMR WebSocket allowed. With `@cloudflare/vite-plugin` the Worker shell runs in workerd.

## Pages Router apps: `proxy.ts`

vinext's Pages Router on Node and Nitro has no single request handler to wrap. Run HypDriv as routing middleware instead:

```ts
// proxy.ts
/// <reference types="@hypdriv/vinext/virtual" />
import hypdrivConfig from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { createProxy } from '@hypdriv/vinext/proxy';

export const proxy = createProxy({ config: hypdrivConfig, manifest });
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)', '/_hypdriv/:path*'] };
```

The stages run before vinext (`runner: 'proxy'`): headers, CSP (vinext applies the forwarded nonce), rate limits, the bot shield, flags, redirects, maintenance and `/_hypdriv/*`. The proxy does not see the rendered body, so nonces are not injected into cached HTML and `hyp()` returns `null`; application code reads HypDriv's facts from the forwarded `x-hypdriv-*` request headers (`headers()`). Inside the plugin's hook or the Worker shell the proxy passes through, so an App Router app can keep its own `proxy.ts` for its own logic. On Cloudflare, `createVinextWorker` covers Pages Router apps fully.

## Limitations

- vinext's multi-stage Workers Cache mode (`workersCacheCdnAdapter()`) renders cached responses in a separate entrypoint (`VinextCachedResponse`): the Drivetrain still runs around every request, but `hyp()` inside such a cached render has no request context.
- Pages Router `res.revalidate()` sends a loopback request through the server; it passes the hook like any request (rate limits and the bot shield apply to it).
- The plugin wraps `virtual:vinext-rsc-entry`, vinext's generated App Router entry; the build fails with a clear error if a future vinext stops loading it, instead of shipping without the hook.
- Verified locally with the Cloudflare Vite plugin v1 and wrangler (`vite preview`, `wrangler dev`), `vinext start`, Nitro's `node-server` preset and an in-process invocation of the Vercel function. Vercel's routing of the static pages, the Cloudflare plugin v2 layout (`.cloudflare/output`, the `cf` CLI) and edge purges on a real zone need a deployment (`e2e/hosts`).

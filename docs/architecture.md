# Hypdriv architecture

> **Hypdriv** is a Hyper-Extension for Next.js 16+ and the Vite frameworks — plain Vite apps, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext, Waku, Nitro and Analog: a sidecar that attaches to an application through its framework's public contracts and makes it faster, safer and more observable, out of the box on Cloudflare Workers, on Vercel and on Node, without forking a framework, OpenNext or Vercel's builder and without requiring any infrastructure beyond the platform itself.

This document is the source of truth for the design. Package READMEs and guides elaborate; they never contradict it.

---

## 1. Design principles

1. **Sidecar, never a fork.** Hypdriv integrates through exactly five attachment points (§3). It never patches `next`, `@opennextjs/*` or `wrangler`. When Next.js changes, Hypdriv adapts at the attachment point.
2. **Zero-infrastructure baseline.** Every feature has a mode that works on a bare Worker with the static-assets binding OpenNext already requires. Cloudflare bindings (KV, R2, D1, Durable Objects, Queues, Rate Limiting, Analytics Engine, Images, AI) are _upgrades_: optional, auto-detected at startup, never required.
3. **Build-time knowledge, run-time use.** The Next.js Adapter API gives Hypdriv a typed description of the application after `next build`. Hypdriv turns it into one artifact (`.hypdriv/manifest.json`) that the runtime reads. Nothing derived from a build is baked back into that same build, which avoids circular dependencies between `next build`, `proxy.ts` and the Worker bundle.
4. **Portable by construction, native per platform.** The proxy composables, server helpers and security primitives run on Node (`next start`), on Vercel and on Workers; a deploy target (`cloudflare` · `vercel` · `node`, detected at build and run time, [ADR 0013](adr/0013-deploy-targets.md)) selects platform overrides for the same pipeline. The Worker shell adds the capabilities only the Cloudflare edge provides (HTML streaming transforms, edge cache storage with coalescing, scheduled/queue handlers, Durable Objects); on Vercel, `@hypdriv/vercel` maps them to the Vercel CDN, Upstash Redis, Global Config, the WAF, BotID and Vercel Queues.
5. **Secure defaults, measurable claims.** Defaults pass securityheaders.com with an A+ and Lighthouse best-practice audits. Every performance feature emits `Server-Timing` entries so its effect is visible, not assumed.
6. **Agent-native.** Every CLI command has `--json`. The repository ships `AGENTS.md` and a skill so coding agents can adopt and operate Hypdriv correctly.
7. **Purser-native CSS.** Purser CSS is the first-class styling path: Hypdriv builds it in-process, verifies that no unstyled atom ships, pins themes at the edge, and audits zero-override guarantees per route.

## 2. Compatibility targets

| Dimension                         | Supported                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Next.js                           | 16.0 → latest 16.x (16.4 at the time of writing); App Router first, Pages Router supported by the runtime stages |
| React                             | 19.2+                                                                                                            |
| Node.js (dev/build, `next start`) | 20.9+ (22+ recommended)                                                                                          |
| Cloudflare                        | Workers with `nodejs_compat`, `compatibility_date >= 2024-09-23`, via `@opennextjs/cloudflare` 1.15+             |
| Vercel                            | Vercel Functions (Node.js runtime) and Routing Middleware; legacy builder and the Next.js adapter (`NEXT_ENABLE_ADAPTER=1`) |
| Bundler                           | Turbopack (default) and `next build --webpack`                                                                   |
| TypeScript in host apps           | 5.9, 6.x, 7.x                                                                                                    |
| Purser CSS                        | 0.1+ (`@avonao/purser/build` API)                                                                                |
| Vite hosts (ADR 0019)             | Vite 8; React Router 8, TanStack Start 1.169+, Astro 7, SvelteKit 3, Nuxt 4.6, vinext 1.4, Waku 1.0 (release candidates), Nitro 2.13 and 3 (release candidate), Analog 2.9, plain Vite apps — on Cloudflare (`@cloudflare/vite-plugin` / framework adapters), Vercel (Build Output API) and Node |

Deprecated Next.js features (`middleware.ts`, Edge runtime route segments) are detected by `hypdriv doctor` and reported with the migration path; Hypdriv does not add support for them.

## 3. Attachment points

```
                 ┌─────────────────────────────────────────────────────────┐
  build time     │ next.config.ts ── withHypDriv() ── Adapter chain        │
                 │   • safe defaults, Purser build, adapterPath chaining   │
                 │   • onBuildComplete → .hypdriv/manifest.json            │
                 └─────────────────────────────────────────────────────────┘
                                   │ manifest (routes, assets, csp, hints)
                                   ▼
                 ┌─────────────────────────────────────────────────────────┐
  request time   │ Worker entry ── createWorker() ── Drivetrain pipeline   │  Cloudflare only
                 │   pre:  shield → limits → flags → cache lookup → …      │
                 │   next: OpenNext worker (Next.js render)                │
                 │   post: headers/CSP → hints → HTML transforms → cache   │
                 │   + scheduled / queue / email / tail handlers           │
                 └─────────────────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────────────────┐
                 │ proxy.ts ── createProxy() ── same stages, Node runtime  │  everywhere
                 └─────────────────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────────────────┐
  app code       │ hyp() context · safeAction · session · cache · flags    │
                 │ live · image · observe · <Speculation/> · <DevTools/>   │
                 └─────────────────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────────────────┐
  tooling        │ hypdriv CLI: init · doctor · analyze · audit · routes   │
                 │ budget · csp · css · warm · bench · deps · manifest     │
                 └─────────────────────────────────────────────────────────┘
```

### 3.1 `next.config.ts` — `withHypDriv`

`withHypDriv(nextConfig, options?)` returns an **async config function** `(phase, { defaultConfig }) => NextConfig`. Next.js supports async configuration, which lets Hypdriv do work before the bundler starts:

- apply safe defaults (`poweredByHeader: false`, `reactStrictMode: true`, immutable `headers()` for `/_next/static`, `deploymentId` when skew protection is on, `experimental.sri` when `security.sri` is on, Workers-friendly `serverExternalPackages` / `turbopack.resolveAlias` entries, `images.loaderFile` when the Cloudflare image loader is enabled);
- run the **Purser bridge**: in `PHASE_PRODUCTION_BUILD` it awaits `build()` from `@avonao/purser/build` so Turbopack/webpack see a current stylesheet; in `PHASE_DEVELOPMENT_SERVER` it starts `watch()` once per process and publishes diagnostics to `.hypdriv/dev/purser.json`;
- install the **adapter chain** (§3.2) by setting `adapterPath` to Hypdriv's adapter module and recording the application's own adapter (from `options.adapter`, the existing `adapterPath`, or `NEXT_ADAPTER_PATH`) in `HYPDRIV_BASE_ADAPTER`.

It never enables Cache Components, Partial Prefetching or the React Compiler by itself; those are application decisions. It validates `hypdriv.config.ts` and fails the build with a readable error list on invalid configuration.

### 3.2 Adapter chain

Next.js 16.2+ exposes the stable Adapter API (`adapterPath`, `modifyConfig`, `onBuildComplete`). Hypdriv registers an adapter that **delegates** both hooks to the base adapter (Vercel, Bun, a future OpenNext adapter, or none) and then performs its own work in `onBuildComplete`:

1. Build the **route table** from `outputs.appPages`, `outputs.appRoutes`, `outputs.pages`, `outputs.pagesApi`, `outputs.prerenders`, `outputs.staticFiles`, `outputs.middleware` and `routing.*`.
2. Attach **client assets per route** from `.next/app-build-manifest.json` and `.next/build-manifest.json` (JS chunks and CSS files), and detect font preloads in prerendered HTML.
3. Classify every route: `static` (prerender with `compute: 'static'`), `shell` (PPR/Cache Components shell: `compute: 'resuming'`), `dynamic` (`compute: 'blocking'` or no prerender), `route` (handler), `asset`.
4. Compute **CSP hashes** for inline `<script>` and `<style>` content of fully static prerendered HTML.
5. Compute **Early Hints** `Link` values per route (stylesheets, main scripts, fonts, configured preconnects).
6. Build the **speculation graph**: same-origin links discovered in prerendered HTML, grouped by route, for Speculation Rules generation.
7. Run the **Purser verification**: every Purser class in prerendered HTML must exist in the generated stylesheet; record atom usage per route.
8. Run the **secrets scan** over client assets when enabled.
9. Measure **weights** (`.open-next/worker.js` when present, client JS per route) and evaluate budgets.
10. Write `.hypdriv/manifest.json` (+ `.hypdriv/manifest.js` for bundlers without JSON import support) and `.hypdriv/report.md`.

Because OpenNext Cloudflare currently consumes the standalone build rather than the Adapter API, the chain is OpenNext-agnostic: `onBuildComplete` fires during `next build`, which OpenNext invokes before its own bundling. When OpenNext ships its Adapter-API-based adapter, it simply becomes the base adapter; Vercel's adapter (`NEXT_ENABLE_ADAPTER=1` → `NEXT_ADAPTER_PATH`) is chained the same way and receives the manifest as an extra asset.

Next.js ≥ 16.4 writes prerenders to scoped paths (`server/route-cache/**`) as soon as any adapter is configured. Without a base adapter, Hypdriv restores the classic `server/app/**` layout after the build (never overwriting files) so OpenNext's cache population and Vercel's legacy builder find every prerender, and adds the manifest to the server traces so every function ships it ([ADR 0014](adr/0014-scoped-build-artifacts.md)).

### 3.3 Worker entry — `createWorker`

`hypdriv init` writes `hypdriv.worker.ts` and points `wrangler.jsonc#main` at it:

```ts
import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from 'hypdriv/durable-objects';
export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
```

`createWorker` returns an `ExportedHandler` with `fetch`, `scheduled`, `queue`, `email` and `tail`. The OpenNext worker is imported lazily so that Hypdriv's own startup cost stays in the low-millisecond range and the Worker still meets the 1 s global-scope limit on large applications.

`fetch` runs the **Drivetrain** (§5) around OpenNext's `fetch`. Internal routes under `/_hypdriv/*` (vitals beacon, CSP reports, health, live channels, dev state) are answered before Next.js is loaded.

### 3.4 `proxy.ts` — `createProxy`

For deployments that are not on Workers (Vercel, Node hosts), and for `next dev`, the same stages run inside `proxy.ts`. On Vercel, `createProxy()` applies `@hypdriv/vercel` automatically: `vercelEnv()` (Global Config / Upstash as KV, Upstash counters, Vercel Queues producers), `vercelPlatformOverrides()` (capabilities, counter stores, WAF binding, purger) and `vercelStages()` (the Vercel CDN stage under the `edge-cache` name, `rate-limit-vercel`, no `html-transforms`); it also registers the process runtime for helpers that run outside a proxied request (`enqueue()` in Vercel Functions):

```ts
import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from './hypdriv.config';
export default createProxy(hypdrivConfig, (defaults, platform) => [...defaults /*, customStage(platform) */]);
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
}; // Next.js parses this statically, so it must be a literal
```

Proxy runs on the Node runtime in Next.js 16, so the manifest is read lazily from disk (`process.cwd()/.hypdriv/manifest.json`, a statically scoped path so Next's file tracing stays small) and cached. Inside the Worker the proxy sees the shell's request context through `AsyncLocalStorage` and passes through, so the stages run exactly once per request; both runners strip client-supplied `x-hypdriv-*`, nonce and `x-middleware-*` headers first. Stages that need a response body (HTML transforms) are marked `edgeOnly` and are no-ops in proxy; the manifest-driven header stages are identical in both places.

### 3.5 Application code

- `hyp()` (server): request context assembled from headers set by the Worker shell or proxy (`x-hypdriv-*`), or directly from the Cloudflare context when running in the Worker. Exposes `requestId`, `nonce`, `geo`, `flags`, `route`, `env`, `waitUntil`, `log`, `span`.
- `safeAction()` / `defineRoute()`: validated, rate-limited, Turnstile-aware, idempotent server functions and route handlers.
- `createSession()`, `jwt`, `signing`, `webhooks`: WebCrypto-based, runtime-agnostic.
- `edgeCache` / `revalidate`: edge cache control from application code, bridging Next's `revalidateTag` with edge purges.
- `defineFlags()` / `flag()` / `useFlag()`: edge-evaluated feature flags.
- `publish()` / `useLive()`: live channels.
- `<Speculation/>`, `<HypDrivDevTools/>`, `<HypImage/>`: client components.

### 3.6 Vite hosts

Frameworks built on Vite attach through their own contracts (ADR 0019). The neutral pieces are shared with Next.js: `@hypdriv/runtime` (stages, platform, runners), `@hypdriv/build` (manifest assembly, static header rules) and `@hypdriv/vite` (the Vite toolkit and the plain-Vite plugin). Each framework package registers a Vite plugin (`hostPlugin`: `virtual:hypdriv/config`, `virtual:hypdriv/manifest`), wraps the framework's request hook with `createHandler()` (`runner: 'host'`, owning the full response), finalises the manifest after the complete build (prerendering and the adapter included), patches it into the built server bundles, and writes the static header rules of the target platform (Cloudflare `_headers`, Vercel Build Output routes, or the framework's native header config). On Cloudflare, frameworks whose Worker entry the application owns use `createWorker({ app })` for `scheduled`/`queue`/Durable Objects; the in-app hook passes through inside it.

| Host | Build integration | Request hook |
| --- | --- | --- |
| plain Vite | `hypdriv()` plugin | `assetsWorker()` (Cloudflare), Hypdriv Routing Middleware (Vercel), `hypdriv serve` (Node) |
| React Router 8 | preset + Vite plugin (`@hypdriv/react-router`) | root route `middleware` / outer `createRequestHandler` wrapper |
| TanStack Start | Vite plugin (`@hypdriv/tanstack-start`) | global request middleware (`src/start.ts`) |
| Astro 7 | integration (`@hypdriv/astro`) | middleware (`order: 'pre'`) |
| SvelteKit 3 | adapter wrapper + Vite plugin (`@hypdriv/sveltekit`) | `handle` |
| Nuxt 4 | module (`@hypdriv/nuxt`) | Nitro middleware and render hooks |
| vinext | Vite plugin (`@hypdriv/vinext`) | `proxy.ts` (`createProxy`) |
| Waku 1 | `withHypDriv()` config wrapper + Vite plugin (`@hypdriv/waku`) | the server-entry adapter (`@hypdriv/waku/adapters/node\|vercel\|cloudflare` wrap Waku's own; `createHandler`, `runner: 'host'`) |
| Nitro 2 and 3 | Nitro module (`hypdrivNitro()`, or the `hypdriv()` Vite plugin carrying it for `nitro/vite`; `@hypdriv/nitro`, ADR 0027) | a Nitro plugin around the request handler (Nitro 2: the h3 app; Nitro 3: `fetch`), with the Worker shell around `cloudflare-module` (`createHandler`, `runner: 'host'`) |
| Analog 2 | `analog(withHypDriv({...}))` + Vite plugin (`@hypdriv/analog`) on top of `@hypdriv/nitro` | the same Nitro plugin around Analog's Nitro server; Angular gets `provideHypDriv()` (nonce, request context) |
| Hono | none (no build step): `useHypDriv(app)` middleware or `wrapHono(app)` (`@hypdriv/hono`) | the app's own `fetch` (`createHandler`, `runner: 'host'`) |

**Prerendered pages.** The platform's static layer serves them (`HypRoute.servedStatically`): their posture is the static header rule (security preset, the document's hash CSP, Early Hints), and neither the build nor the runtime infers an edge-cache policy for them. To run the request stages (rate limits, bot shield, maintenance, flags) for them as well:

- **Cloudflare:** `assets.run_worker_first` sends them to the Worker shell, which answers GET/HEAD from the assets binding first, so the page is still served as built, with its hash CSP. `hypdriv init` writes the right patterns per framework (`/*` minus the immutable asset directory).
- **Vercel:** every integration writes Hypdriv's Routing Middleware (`addVercelMiddleware()`) scoped to exactly the prerendered document paths (GET/HEAD; vinext also skips RSC and Server Action requests). On-demand routes run the pipeline once, in the function. A plain Vite SPA runs the middleware for every non-immutable path.

**HTTPS.** `redirects.forceHttps: 'auto'` follows `site.origin`; without one it is on for Cloudflare and Vercel deployments (their edge terminates TLS for every hostname) and off on Node. Workers Static Assets answer before the Worker, so plain-HTTP requests for assets the Worker never sees need the zone's *Always Use HTTPS* (or a Redirect Rule); `hypdriv audit https` probes pages, `/_hypdriv/health` and a hashed asset over `http://` and names the setting when one is served.

### 3.7 CLI

`hypdriv` is a dependency-light Node CLI (Node's `util.parseArgs`, no interactive-framework dependency) with JSON output on every command. See §10.

## 4. Build-time artifact: the manifest

`.hypdriv/manifest.json` (schema version 1) is produced by the adapter chain and read by the Worker shell, the proxy composables and the CLI. It is deliberately denormalised so the runtime does no joins.

```ts
interface HypManifest {
  version: 1;
  buildId: string;
  deploymentId?: string;
  nextVersion: string;
  hypdrivVersion: string;
  generatedAt: string; // ISO-8601
  basePath: string;
  trailingSlash: boolean;
  routes: HypRoute[]; // ordered: static, then dynamic by specificity
  proxy?: { matchers: ProxyMatcher[] };
  staticFiles: { count: number; immutablePrefixes: string[] };
  earlyHints: Record<string, string[]>; // routeId → Link header values
  csp: Record<string, { scriptHashes: string[]; styleHashes: string[] }>; // static routes only
  speculation: { graph: Record<string, string[]>; excluded: string[] };
  purser?: PurserManifest;
  weights: { client: Record<string, { js: number; css: number }>; worker?: WorkerWeight };
  budgets?: BudgetResult[];
  warnings: string[];
}

interface HypRoute {
  id: string; // stable id, e.g. "app:/blog/[slug]"
  pathname: string; // Next.js route pattern
  regex: string; // compiled matcher (from routing.dynamicRoutes or derived)
  kind: 'app-page' | 'app-route' | 'page' | 'page-api' | 'static-file';
  classification: 'static' | 'shell' | 'dynamic' | 'route' | 'asset';
  runtime: 'nodejs' | 'edge';
  dynamic: boolean;
  prerender?: {
    routeType?: string;
    response?: string;
    compute?: string;
    revalidate?: number | false;
    expire?: number;
    htmlSize?: number;
    fallback?: boolean;
  };
  assets: { js: string[]; css: string[]; fonts: string[] };
  cachePolicyId?: string; // resolved from hypdriv.config cache policies
  ensureStatic?: 'navigation' | 'prefetch' | 'shell';
}
```

Routes are matched at runtime with a compiled trie (static paths) plus ordered regexes (dynamic paths); the matcher lives in `@hypdriv/core` and is shared by Worker, proxy and CLI.

## 5. The Drivetrain pipeline

`@hypdriv/core` defines a small, explicit pipeline model that both the Worker shell and the proxy composables use:

```ts
interface Stage {
  name: string;
  /** Runs before Next.js. May short-circuit by returning a Response. */
  pre?(ctx: HypContext): Promise<Response | undefined | void> | Response | undefined | void;
  /** Runs after Next.js with the response. Returns the (possibly new) response. */
  post?(ctx: HypContext, response: Response): Promise<Response> | Response;
  /** Stages that must stream/transform bodies declare it; proxy skips them. */
  edgeOnly?: boolean;
}
```

Execution order is fixed by the stage list the application passes (or by the default list built from `hypdriv.config.ts`). The default order is:

| #   | Stage              | pre                                                                         | post                                                                 |
| --- | ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `request-id`       | assign id, start timings, create logger/span                                | `x-request-id`, `x-hypdriv-request-id`, `Server-Timing`, end span    |
| 2   | `maintenance`      | serve maintenance page when enabled                                         | —                                                                    |
| 3   | `shield`           | WAF-lite rules, method allow-list, path traversal, body limits              | —                                                                    |
| 4   | `bots`             | classify (owner audit tokens pass), Turnstile challenge, block/log          | `x-hypdriv-bot`                                                      |
| 5   | `rate-limit`       | per-policy limiters (memory → Cache API → KV/Upstash → Durable Object → binding) | `RateLimit-*` headers                                           |
| 6   | `rate-limit-vercel`| Vercel WAF rate-limit rules mapped to policies (Vercel only)                | —                                                                    |
| 7   | `geo`              | geo context → `x-hypdriv-geo`                                               | —                                                                    |
| 8   | `i18n`             | negotiate locale, redirect                                                  | —                                                                    |
| 9   | `flags`            | evaluate flags → `x-hypdriv-flags`                                          | set bucketing cookie once                                            |
| 10  | `redirects`        | static + KV redirect table, canonical host, https                          | —                                                                    |
| 11  | `theme`            | read theme cookie / client hints → `x-hypdriv-theme`                        | pin `<html class>` (HTMLRewriter), `Accept-CH`, `Vary`               |
| 12  | `speculation`      | prepare per-route rules, register their CSP hash                            | replace the component's document rules with graph rules (edge)     |
| 13  | `csp`              | pick mode (nonce/hash/report-only), set request CSP for nonce mode          | response CSP (also on proxy pass-through); nonce injection into cached HTML (edge) |
| 14  | `edge-cache`       | lookup / coalesce / serve stale — on Vercel: plan the CDN policy            | store, `x-hypdriv-cache`, `Cache-Tag` — on Vercel: `Vercel-CDN-Cache-Control`, `Vercel-Cache-Tag` |
| 15  | `security-headers` | —                                                                           | HSTS, COOP, CORP, Permissions-Policy, …                              |
| 16  | `early-hints`      | —                                                                           | `Link` headers from the manifest                                     |
| 17  | `html-transforms`  | —                                                                           | comment stripping, whitespace, priority hints (edge only)            |
| 18  | `skew`             | detect deployment skew                                                      | reload instruction                                                   |
| 19  | `devtools`         | —                                                                           | per-request facts as `Server-Timing` `hyp-*` entries (HUD)            |
| 20  | `observe`          | —                                                                           | request log line, flush spans in `waitUntil`                          |

Post steps run in reverse order: `edge-cache.post` stores the document exactly as Next.js produced it, then `csp.post`, `speculation.post` and `theme.post` apply the per-request work (nonce, edge rules, theme classes) on misses and hits alike, and `request-id.post` serialises the final `Server-Timing`.

`HypContext` carries `request`, `url`, `route`, `env`, `cf`, `state` (typed slots written by stages, e.g. `nonce`, `cacheDecision`, `flags`), `timings`, `log`, `waitUntil` and `signal`.

## 6. Caching model

Hypdriv's **edge cache** sits in front of Next.js and complements, never replaces, Next's own caches (Cache Components, ISR via OpenNext's incremental cache):

- **Policies** are declared in `hypdriv.config.ts` (`cache.edge`), matched by route pattern, with `ttl`, `swr`, `staleIfError`, `tags`, `vary` (headers, cookies, geo dimensions, flags), `bypass` (cookie/header presence) and `methods`.
- **Inference**: routes classified `static` default to a long edge TTL with SWR and tag `route:<id>`; `shell` routes cache only when the application opts in (streaming resumes are never cached); `dynamic` routes are bypassed unless a policy says otherwise; RSC payload requests (`RSC: 1`) are keyed separately and include the `Next-Router-State-Tree`/`Next-Url` headers in the key.
- **Keys** are normalised: lowercase host, sorted query, tracking parameters removed (`utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_*`, `_hs*`), trailing slash kept as requested (the other form is a redirect, never the same entry), build id included so deployments never serve mixed content.
- **Stores**: `cacheApi` (Workers `caches.default`, per-colo, zero config), `memory` (Node/dev, LRU), `kv` (optional, global), `tiered` (memory → cacheApi → kv). Stores hold the full `Response` plus a metadata header block (`stored-at`, `ttl`, `swr`, `tags`, `key`, `build`).
- **Behaviour**: single-flight coalescing per isolate; stale-while-revalidate in `waitUntil`; stale-if-error on upstream 5xx/exception; negative caching of 404s (short TTL); `Vary` normalisation; `Cache-Tag` and `Surrogate-Key` headers emitted for zone-level purge.
- **Purge**: `revalidateTag`/`revalidatePath` wrappers (`@hypdriv/next/cache`) call Next and then purge the edge (tag index in KV or the `HypDrivIndex` Durable Object when available; Cloudflare zone purge API when a token is configured; otherwise TTL/SWR bounds staleness and the deployment build id provides a hard reset).
- **Warming**: `hypdriv warm` fetches the top routes after deploy; the `scheduled` handler can re-warm routes listed in config or learned from vitals data.

## 7. Security model

- **CSP autopilot**: the manifest tells Hypdriv which routes are fully static. Static routes receive a **hash-based** strict CSP (`script-src 'self' 'sha256-…' 'strict-dynamic'`) as a response header, so they stay cacheable. Dynamic and shell routes receive a **nonce-based** strict CSP delivered through request headers so Next.js applies the nonce to its inline scripts. Report-only mode, `report-to`/`report-uri` to the built-in collector (`/_hypdriv/csp-report`), and a `hypdriv csp suggest` command that turns collected violations into policy proposals.
- **Headers preset** (A+ on securityheaders.com): HSTS (preload-ready), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (deny by default with an allow-list), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Cross-Origin-Embedder-Policy` (opt-in), `Origin-Agent-Cluster`, `X-Frame-Options` via `frame-ancestors`, `X-Permitted-Cross-Domain-Policies`, `X-DNS-Prefetch-Control`.
- **Rate limiting**: algorithms (`fixedWindow`, `slidingWindow`, `tokenBucket`) over counters stored in memory (per isolate), Cache API (approximate, zero-config), KV, the `HypDrivLimiter` Durable Object (exact, global) or Cloudflare's Rate Limiting binding. IETF `RateLimit-*` headers and `Retry-After`.
- **Bot shield**: uses `request.cf.botManagement` and `verifiedBotCategory` when present; falls back to UA/header heuristics, honeypot paths and `Sec-Fetch-*` validation; policies `allow | challenge | block | tarpit`; Turnstile verification for forms and actions.
- **Server functions**: `safeAction()` wraps Server Actions with Standard Schema validation, auth guards, rate limits, Turnstile, idempotency keys, structured errors and audit hooks; `defineRoute()` does the same for Route Handlers and adds ETag/304 and caching helpers.
- **Sessions and crypto**: AES-256-GCM encrypted cookies with HKDF-derived, versioned keys (rotation without logout), signed URLs/cookies, JWT verification with JWKS caching, webhook signature verification (Stripe, GitHub, Standard Webhooks), password hashing (scrypt when `node:crypto` is available, PBKDF2-SHA-256 otherwise), constant-time comparison.
- **Build-time**: secrets scan over client assets (known key formats plus non-public environment values), optional SRI, CSP hash computation, open-redirect guard for `redirect()` targets.

## 8. Observability model

- **Tracing**: a minimal span model compatible with OpenTelemetry semantics (trace/span ids, W3C `traceparent` propagation, attributes, events, status). Exporters: console JSON (Workers Logs), OTLP/HTTP JSON (Honeycomb, Grafana, Axiom, Dash0, …), Analytics Engine data points. Spans flush in `waitUntil`; no SDK dependency.
- **Logging**: structured JSON, request-scoped fields, secret redaction, sampling.
- **Server-Timing**: every stage reports its duration and outcome (`cache;desc=HIT;dur=1.2`). In development the entries carry extra detail; the DevTools HUD reads them through `PerformanceNavigationTiming.serverTiming`, which needs no endpoint.
- **Web Vitals**: a tiny client reporter (`useReportWebVitals` from `next/web-vitals`) beacons to `/_hypdriv/vitals` with route, build id and cache status attribution; sinks are Analytics Engine, logs or a custom function. `hypdriv vitals` prints p75 per route from Analytics Engine's SQL API, and `observe.vitals.dashboard` serves the same numbers (plus rating split and trends) at the token-protected `/_hypdriv/dash`, from the SQL API or, without credentials, from a bounded in-memory buffer of the measurements one instance receives.
- **Next.js hooks**: helpers for `instrumentation.ts` (`register`, `onRequestError`) and `instrumentation-client.ts`.

## 9. Purser CSS integration

Purser produces one deterministic atomic stylesheet with provable no-override rules. Hypdriv's bridge (`@hypdriv/purser`) adds:

1. **In-process build/watch** from `withHypDriv` (no `&` process juggling; errors become build failures or dev diagnostics).
2. **Unstyled-atom guard**: after `next build`, every Purser class referenced by prerendered HTML must exist in the stylesheet. A stale stylesheet fails the build.
3. **Atom usage report**: atoms per route and unused atoms (dead styles), written to the manifest and `hypdriv routes --css`.
4. **Flashless themes at the edge**: the `theme` stage sets the axis classes on `<html>` from a cookie or the `Sec-CH-Prefers-Color-Scheme` client hint before the HTML leaves the edge (no inline script, CSP-clean). A hashed inline fallback script is available for non-Worker deployments.
5. **Early Hints** for the Purser stylesheet on every route.
6. **Zero-override audit**: `hypdriv audit css --url` crawls the routes in the manifest with headless Chrome and runs Purser's strike-count check at several widths and theme states; CI-ready.
7. **Layer coexistence** helpers for Tailwind/legacy CSS adoption (ordered `@layer` statement generation).

Hypdriv consumes only `@avonao/purser/build` and `scripts/strike-count.js`; it never modifies Purser.

## 10. CLI

| Command            | Purpose                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hypdriv init`     | detect Next/OpenNext/Purser/TS, write `hypdriv.config.ts`, `hypdriv.worker.ts`, wrap `next.config.ts`, update `wrangler.jsonc`, add scripts                                                                     |
| `hypdriv doctor`   | environment, Next version and config, Workers compatibility (compat date/flags, Node APIs, edge runtime exports), worker size and startup risk, env leaks, header posture, Purser setup; `--fix` for safe fixes |
| `hypdriv analyze`  | Worker weight report from the bundle + source map (per-source attribution), per-route client JS/CSS, largest dependencies, duplicate modules                                                                    |
| `hypdriv routes`   | the manifest as a table: classification, cache policy, CSP mode, hints, atoms                                                                                                                                   |
| `hypdriv audit`    | `headers`, `csp`, `cache`, `https`, `css`, `all` against a URL or the local preview                                                                                                                                      |
| `hypdriv budget`   | evaluate budgets, store snapshots, diff against the previous build, Markdown for PR comments                                                                                                                    |
| `hypdriv csp`      | `hashes`, `suggest` (from collected reports), `print`                                                                                                                                                           |
| `hypdriv css`      | Purser `build` / `check` / `watch` through the bridge                                                                                                                                                           |
| `hypdriv warm`     | fetch top routes after deploy                                                                                                                                                                                   |
| `hypdriv purge`    | purge the edge cache of a deployment by tag, path or build through the signed `/_hypdriv/purge` endpoint (all tiers)                                                                                          |
| `hypdriv bench`    | TTFB p50/p95 and cache status distribution against a URL list                                                                                                                                                   |
| `hypdriv deps`     | daily dependency freshness report; `--update safe                                                                                                                                                               | major` |
| `hypdriv manifest` | print or validate the manifest                                                                                                                                                                                  |
| `hypdriv agent`    | print agent guidance (what to do in this project)                                                                                                                                                               |

Every command accepts `--json` and `--root <dir>`.

## 11. Package map

| Package               | Runtime                                               | Depends on                                          |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| `@hypdriv/core`       | neutral                                               | —                                                   |
| `@hypdriv/cache`      | neutral                                               | core                                                |
| `@hypdriv/security`   | neutral                                               | core                                                |
| `@hypdriv/observe`    | neutral                                               | core                                                |
| `@hypdriv/flags`      | neutral + React                                       | core                                                |
| `@hypdriv/live`       | Workers + React                                       | core, cloudflare (DO)                               |
| `@hypdriv/image`      | neutral + React                                       | core                                                |
| `@hypdriv/purser`     | Node (bridge) + neutral (runtime bits)                | core                                                |
| `@hypdriv/runtime`    | neutral (stages, platform, `createHandler`, `createProxyHandler`, `hyp()`) | core, cache, security, observe, flags, live, purser, vercel |
| `@hypdriv/build`      | Node (manifest assembly, static header rules)          | core, runtime, security, purser                     |
| `@hypdriv/next`       | Node (config/adapter/proxy) + neutral (server/client) | core, runtime, build, cache, security, observe, flags, purser, vercel |
| `@hypdriv/vite`       | Node (plugin, toolkit, `/node` server) + Workers (`/worker`) + Vercel Routing Middleware (`/vercel-middleware`) | core, runtime, build, security, cloudflare |
| `@hypdriv/react-router`, `@hypdriv/tanstack-start`, `@hypdriv/astro`, `@hypdriv/sveltekit`, `@hypdriv/nuxt`, `@hypdriv/vinext`, `@hypdriv/waku` | framework integrations | vite, runtime, cloudflare |
| `@hypdriv/nitro` | Node (module, build) + neutral (Nitro 2 and 3 request hooks, `/server`) + Workers (Worker entry) | core, runtime, build, flags, vite, cloudflare |
| `@hypdriv/analog` | Node (Vite plugin, file-router discovery) + neutral (Angular `/angular`, `/angular/server`, `/server`) | core, runtime, vite, nitro |
| `@hypdriv/hono` | Hono middleware and fetch wrapper, route manifest from `app.routes` | core, runtime |
| `@hypdriv/cloudflare` | Workers                                               | core, runtime, cache, security, observe, flags, live, purser |
| `@hypdriv/vercel`     | neutral (Vercel Functions, Routing Middleware)        | core, cache, security                               |
| `@hypdriv/devtools`   | browser + neutral                                     | core                                                |
| `@hypdriv/testing`    | Node + Workers                                        | core                                                |
| `@hypdriv/cli`        | Node                                                  | core, purser, security (scan), next (adapter utils) |
| `create-hypdriv`      | Node (templates synced from `examples/*`)             | —                                                   |
| `hypdriv`             | umbrella                                              | re-exports + bin                                    |

Dependency rule: runtime packages have **no** dependency on `next`, `wrangler` or Node built-ins except through clearly isolated entry points (`/node`). Peer dependencies on `next`, `react`, `@opennextjs/cloudflare` are declared where needed and marked optional when the feature degrades gracefully.

## 12. Versioning and compatibility policy

- Semantic versioning. All `@hypdriv/*` packages release in lockstep (linked in changesets) so one version number describes a compatible set.
- A new Next.js minor is supported within one Hypdriv minor; Hypdriv's CI matrix pins the latest Next 16 minor and the previous one.
- The manifest schema has an explicit `version`; the runtime refuses to start on an unknown major schema version and explains how to rebuild.
- Breaking changes require a major release and a codemod or a `hypdriv doctor --fix` rule.

## 13. Testing strategy

- Unit tests (vitest, Node) for all pure logic with exhaustive edge cases (cache keys, CSP serialisation, header merges, rate-limit windows, manifest derivation from fixture outputs).
- Workers-runtime tests (`@cloudflare/vitest-pool-workers`) for Cache API stores, Durable Objects, the Worker shell and HTMLRewriter stages.
- Fixture builds: a captured `onBuildComplete` context from a Next 16.4 build drives adapter tests without running Next.
- Example apps (`examples/basic`, `examples/with-purser`) run end-to-end in CI with `opennextjs-cloudflare build` + `wrangler dev`, asserting headers, CSP validity, cache statuses and zero Purser overrides.

## 14. Non-goals

- Replacing OpenNext, Next's caches, Next DevTools or Vercel's observability. Hypdriv composes with them.
- Supporting the deprecated Edge runtime or `middleware.ts`.
- Vendor lock-in: nothing in the application API references Cloudflare types directly; `@hypdriv/cloudflare` is the only package that does.

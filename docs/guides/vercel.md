# Hypdriv on Vercel

> **Preview install.** The 0.1.0 packages are distributed as release-bundle tarballs and source, not through a package registry. Where this page shows `npm create hypdriv@latest` or `pnpm add hypdriv`, scaffold with `--no-install` and run the bundle's `install.sh <app root>` (or install the tarballs of the packages you use). See [Install a Preview build](../../README.md#install-a-preview-build).

On Vercel, Hypdriv runs where Vercel runs your code: the Drivetrain stages in **Routing Middleware** (`proxy.ts`), server helpers in **Vercel Functions**, and the build integration in `next build` (`withHypDriv` and the chained adapter). There is no Worker entry and no extra infrastructure: platform services — the Vercel CDN, Upstash Redis, Global Config, the Vercel WAF, BotID, Vercel Queues — are upgrades Hypdriv detects from the environment, exactly like bindings on Cloudflare.

Vercel is detected automatically (`VERCEL=1` during builds and in functions, a `vercel.json` / `.vercel` directory locally); set `platform: 'vercel'` in `hypdriv.config.ts` to make it explicit. US-first: the examples deploy to `iad1`; add an EU region (`fra1`, `cdg1`) only where EU operations require it.

## New project

```sh
npm create hypdriv@latest my-app -- --platform vercel            # add --purser for Purser CSS
cd my-app
pnpm dev                 # next dev: proxy.ts runs the Hypdriv stages
pnpm build               # next build: manifest, Purser, Vercel CDN route headers
vercel deploy            # or connect the repository in the Vercel dashboard
```

`create-hypdriv` writes `.env.local` with generated `HYPDRIV_SESSION_SECRET`, `HYPDRIV_INTERNAL_SECRET` and `CRON_SECRET`; add the same names to the project (`vercel env add <NAME>`).

## Existing project

```sh
pnpm add hypdriv
npx hypdriv init --platform vercel
```

`hypdriv init` wraps `next.config.ts` in `withHypDriv()`, writes `hypdriv.config.ts`, `proxy.ts` and `instrumentation.ts`, adds `.env.example` and the `hypdriv:*` scripts, and reports Vercel-specific findings through `hypdriv doctor --platform vercel`.

```ts
// next.config.ts
import { withHypDriv } from 'hypdriv/config';
export default withHypDriv({ cacheComponents: true, partialPrefetching: true });
```

```ts
// proxy.ts
import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from './hypdriv.config';

export default createProxy(hypdrivConfig); // wires @hypdriv/vercel when the target is Vercel
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
};
```

```ts
// instrumentation.ts
import { createInstrumentation } from 'hypdriv/instrumentation';
import config from './hypdriv.config';

const hypdriv = createInstrumentation({ config });

export async function register() {
  await hypdriv.register(); // registers config + Vercel env for helpers outside a proxied request (enqueue)
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.VERCEL === '1') {
    // Optional SDKs: register only what you use (see "Platform SDKs").
    const { send, handleCallback } = await import('@vercel/queue');
    const { registerVercelSdk } = await import('hypdriv/vercel');
    registerVercelSdk({ queue: { send, handleCallback } });
  }
}
export const onRequestError = hypdriv.onRequestError;
```

## What `createProxy` does on Vercel

When the deploy target is Vercel, `createProxy()` (no extra code) applies `@hypdriv/vercel`:

| Default (Cloudflare / Node) | On Vercel |
| --- | --- |
| `edge-cache` stores responses in Cache API / KV | `edge-cache` becomes the Vercel CDN stage: it expresses the matched policy as `Vercel-CDN-Cache-Control` (+ `CDN-Cache-Control` with `vercel.cdn.downstream`) and `Vercel-Cache-Tag`; `x-hypdriv-cache: CDN` |
| KV binding (`HYPDRIV_KV`) for flags, redirects, maintenance | Global Config (`GLOBAL_CONFIG`, then `EDGE_CONFIG`) — read-only — else Upstash Redis |
| Rate-limit counters: Durable Object / Cache API / memory | Upstash Redis (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) for exact global counters; per-instance memory otherwise |
| Rate Limiting binding | Vercel WAF rules (`vercel.firewall.rateLimitRules`) through the `rate-limit-vercel` stage |
| Tag purge through the tag index + zone purge | Vercel CDN tag purge: the request-context purge API inside Vercel, the REST API (`VERCEL_TOKEN`) elsewhere |
| `html-transforms` (HTMLRewriter) | not available on Vercel; removed |

`revalidateTag()`, `revalidatePath()` and `purgeEdge()` from `hypdriv/cache` purge Vercel's CDN on Vercel — in Routing Middleware and in Vercel Functions alike: Route Handlers and Server Actions run in a separate invocation from `proxy.ts`, so `createInstrumentation().register()` registers the same Vercel CDN purger there, and the repeat purge runs under Vercel's `waitUntil`. `revalidatePath('/products/42')` purges the page's `hyp:path:/products/42` tag (every cached variant) even without a request URL. `/_hypdriv/health` lists the services in use (`config store: Global Config …` once `GLOBAL_CONFIG` is set) and reports `VERCEL_DEPLOYMENT_ID` as `deployment`.

## Caching on Vercel

Vercel runs Routing Middleware **before** its CDN cache, and the cache stores what the **function** returns, so headers set in `proxy.ts` reach the browser but do not make Vercel cache anything. Hypdriv therefore puts the CDN headers where Vercel's cache reads them:

- **Pages** — `withHypDriv` turns explicit edge-cache policies into `next.config` `headers()` rules (they show up in `.vercel/output/config.json`). Only policies whose meaning survives static route headers are emitted: `respectOrigin: false`, no `Vary` needs, translatable patterns. The build log lists the rest with the reason.
- **Route Handlers** — wrap them with `withVercelCdn` (same planning and verdict as the stage, reads `.hypdriv/manifest.json` for route and build tags):

  ```ts
  // app/api/products/route.ts
  import { withVercelCdn } from 'hypdriv/vercel';
  import config from '@/hypdriv.config';
  export const GET = withVercelCdn(config, async () => Response.json(await listProducts()));
  ```

- **Prerendered and ISR pages** are cached by Vercel natively; Hypdriv does not override them.

```ts
// hypdriv.config.ts
cache: {
  edge: {
    policies: [
      { id: 'products', match: '/products/:id', ttl: '5m', swr: '1h', respectOrigin: false, tags: ['catalog'] }, // route headers
      { id: 'products-api', match: '/api/products', ttl: '1m', swr: '10m', tags: ['catalog'] },              // withVercelCdn
    ],
  },
},
```

Not expressible on Vercel's CDN (its key is the URL plus `Vary` request headers, and `Vary: Cookie` makes a response uncacheable): `vary.cookies`, `vary.flags`, `bypass.cookies`, `bypass.when`, `vary.language` with the cookie strategy. Those policies send no CDN headers (`cache;desc=BYPASS`) and log a one-time warning.

**Pages with `vary`** (`geo`, `language`, `device`, `headers`) have no route-header form either: a function's own `Vary` replaces route-level ones, so Vercel would cache one variant for everybody. The build warns (`has no Vercel route-header form (vary)`), the proxy reports such pages as `x-hypdriv-cache: BYPASS` with `x-hypdriv-cache-reason: route-header:vary`, and `hypdriv audit cache` shows a warning instead of a failure. Route Handlers apply the same policy with `withVercelCdn`, which adds `Vary: X-Vercel-IP-Country` (and friends) to the function response — verified live: one CDN entry per country. The same applies to patterns that have no `next.config` `source` form (`route-header:pattern:…`).

**Tag-revalidated prerenders.** A prerendered page whose data carries explicit cache tags (`fetch(…, { next: { tags } })`, `unstable_cache(…, { tags })`, `cacheTag()`) is regenerated by `revalidateTag()`, so its HTML changes after the build. Hypdriv classifies it as `isr` ([ADR 0018](../adr/0018-tag-revalidated-prerenders.md)): on Vercel it gets the CSP fallback below instead of build-time hashes that would block the regenerated inline scripts.

## CSP on Vercel

- **Static routes** get the hash-based policy from the build manifest (A+).
- **Dynamic routes** get a per-request nonce; Next.js applies it to its inline scripts.
- **ISR pages, tag-revalidated prerenders and PPR shells** are served from a cache that no per-request nonce can reach, and Vercel has no `HTMLRewriter` to inject one at the edge. Hypdriv sends its documented fallback (`script-src 'self' 'unsafe-inline'` with every other directive strict, `x-hypdriv-csp: unsafe-inline-fallback`). `hypdriv audit csp` reports it as a warning with the options: render the route dynamically (`await connection()`), or serve it through the Cloudflare Worker for edge nonces.

## Jobs and queues

**Vercel Cron** calls job routes with `GET`, `Authorization: Bearer $CRON_SECRET` and `x-vercel-cron-schedule`; `jobHandler` accepts it (and the signed requests of `hypdriv jobs run`). The job name and schedule come from the matching `jobs.cron` entry (by path) when the request names neither, and the secrets' env names from `vercel.cronSecretEnv` and `security.internalAuth.secretEnv`. On **Hobby**, cron jobs run at most once a day, somewhere within the scheduled hour; trigger a run on demand with `vercel crons run /api/jobs/digest` (`POST /v1/projects/{id}/crons/run`), which sends exactly what a scheduled run sends:

```json
// vercel.json
{ "regions": ["iad1"], "crons": [{ "path": "/api/jobs/digest", "schedule": "0 9 * * 1" }] }
```

```ts
// app/api/jobs/digest/route.ts
import { jobHandler } from 'hypdriv/server';
const digest = jobHandler({ job: 'digest' }, async ({ job, cron }) => ({ job, cron }));
export const GET = digest; // Vercel Cron
export const POST = digest; // hypdriv jobs run / Cloudflare dispatch
```

**Vercel Queues** back `enqueue()` once `@vercel/queue` is registered; until then (and outside Vercel) `enqueue()` calls the consumer route directly with a request signed by `HYPDRIV_INTERNAL_SECRET` (through `VERCEL_URL`, with `VERCEL_AUTOMATION_BYPASS_SECRET` for protected deployments). Map Hypdriv queue names to topics with `vercel.queues` and consume with `queueConsumer`:

```ts
// app/api/queues/emails/route.ts
import { queueConsumer } from 'hypdriv/vercel';
import config from '@/hypdriv.config';
export const POST = queueConsumer(async ({ job, messages }) => ({ retry: [] }), { config });
```

```json
// vercel.json
{ "functions": { "app/api/queues/emails/route.ts": { "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "transactional-email" }] } } }
```

Verified on Hobby: deliveries arrive within about a second, a message the consumer returns in `retry` is redelivered after 5 s with `attempts: 2` (doubling up to 15 min), and a queue with `jobs.queues[name].retry: 'none'` acknowledges a failed message instead of redelivering it. Vercel Queues has no dead-letter queue: a message that keeps failing is redelivered until its retention (24 h by default) runs out, so consumers should give up explicitly (`retry: 'none'`, or drop the id from `retry` after N attempts). Topics are scoped to the project.

**Outbound fetches in Vercel Functions.** Next.js tees `fetch` response bodies, and a teed body's `cancel()` only settles once every branch is consumed — that is, never, if you only cancel your own. Hypdriv never awaits a body cancel (`hypFetch` retries, `enqueue()`'s inline consumer call, cache warming); do the same in application code (`void res.body?.cancel()`), or the function hangs until its time limit. `hypFetch` timeouts settle the attempt themselves (`E_TIMEOUT`) instead of relying on the fetch implementation to honour the abort signal.

## Platform SDKs

`@hypdriv/vercel` never imports Vercel SDKs; register the ones you use once per process (instrumentation is the natural place):

| SDK | Enables |
| --- | --- |
| `@vercel/firewall` (`checkRateLimit`) | `vercel.firewall.rateLimitRules` (WAF rate-limit rules per Hypdriv policy) |
| `botid` (`checkBotId`) | `botIdGuard()` for `safeAction` and `verifyBotId()` |
| `@vercel/queue` (`send`, `sendBatch`, `handleCallback`) | `enqueue()` through Vercel Queues, `queueConsumer()` |

```ts
// instrumentation.ts — registered once; Routing Middleware (the WAF stage) and Functions both see it
if (process.env.NEXT_RUNTIME === 'nodejs') {
  const [{ send, handleCallback }, { checkBotId }, { checkRateLimit }, { registerVercelSdk }] = await Promise.all([
    import('@vercel/queue'),
    import('botid/server'),
    import('@vercel/firewall'),
    import('hypdriv/vercel'),
  ]);
  registerVercelSdk({ queue: { send, handleCallback }, checkBotId, checkRateLimit });
}
```

- **WAF rate limits** (all plans; Hobby allows one rate-limit rule among three custom rules). Create a rule whose condition is `@vercel/firewall` with a rate-limit id (REST: `{ "type": "rate_limit_api_id", "op": "eq", "value": "api-limit" }`, action `rate_limit` with `fixed_window`, `window`, `limit`, `keys: ["ip"]`), map it in `vercel.firewall.rateLimitRules: { api: 'api-limit' }`, and the `rate-limit-vercel` stage answers the policy's 429 with `Retry-After` once Vercel reports the key as limited. Hypdriv passes the policy's key (`<policy>|ip=…`) as `rateLimitKey`. Counters are per region.
- **BotID** (Basic is free on every plan). Wrap the Next config as `withHypDriv(withBotId(nextConfig))` (BotID's rewrites for its challenge script stay intact), call `initBotId({ protect: [{ path: '/api/checkout', method: 'POST' }] })` in `instrumentation-client.ts`, then guard actions with `botIdGuard()` or call `verifyBotId()` in the handler. `vercel.botId.checkLevel` sets the default level of `botIdGuard()`. Scripts without the challenge headers are classified as bots; the browser attaches `x-is-human` to protected requests. Headless browsers are classified as bots too, and `HeadlessChrome` user agents are blocked on documents by the bot shield before BotID is asked.
## Environment variables

| Variable | Purpose |
| --- | --- |
| `HYPDRIV_SESSION_SECRET` | encrypted sessions, CSRF |
| `HYPDRIV_INTERNAL_SECRET` | signed internal requests (`enqueue()` fallback, `hypdriv jobs run`, audit tokens) |
| `CRON_SECRET` | Vercel Cron authentication |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | Upstash Redis: exact rate limits, read-write KV |
| `GLOBAL_CONFIG` (or `EDGE_CONFIG`) | Global Config: flags, redirects, maintenance switch |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | REST purge outside a Vercel request (CI, scripts) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | set by Vercel once a Protection Bypass for Automation exists: lets `enqueue()`'s fallback and your own self-requests reach a protected deployment; the CLI sends it as `x-vercel-protection-bypass` |

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_ID` and `VERCEL_DEPLOYMENT_ID` are system variables Vercel sets.

Vercel binds environment variables to a deployment when it is created: changing one (for example switching `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` to Cloudflare's test keys) takes effect with the next deployment, not on the running one.

**Global Config** is read through its read endpoint with a **read token** (create one per store: `POST /v1/global-config/{id}/token`, connection string `https://edge-config.vercel.com/<id>?token=<token>`), never with an account token. Items are written through the REST API (`PATCH /v1/global-config/{id}/items` with `upsert` / `delete`) or the dashboard; Hypdriv reads each key with a 1 s per-instance cache, so a changed redirect table, flag set or maintenance switch is live within a few seconds (1–4 s observed).

## Build integration

- **Legacy builder and adapter.** Vercel's builder reads `.next/server/app/**`; Next.js ≥ 16.4 writes prerenders to `.next/server/route-cache/**` whenever an adapter is configured. Because Hypdriv installs an adapter, it restores the classic layout after the build (never overwriting files), so prerenders, ISR and PPR fallbacks reach `.vercel/output`. With Vercel's Next.js adapter enabled (`NEXT_ENABLE_ADAPTER=1`, which sets `NEXT_ADAPTER_PATH`), Hypdriv chains it: Vercel's adapter receives the build unchanged plus the Hypdriv manifest as an extra asset.
- **The manifest ships with every function** (`.hypdriv/manifest.json` is added to the server traces), so the proxy, `withVercelCdn` and server helpers read route classifications and CSP hashes at run time.
- **Deployment ids and images** stay Vercel's: `withHypDriv` sets no `deploymentId` and keeps Vercel Image Optimization (no Cloudflare loader).

## Tooling

```sh
pnpm exec hypdriv doctor --platform vercel        # env vars, vercel.json, crons, regions, function sizes, build output
vercel build && pnpm exec hypdriv analyze --platform vercel   # function sizes vs the 250 MB limit
pnpm start &                                      # or a preview deployment URL
pnpm exec hypdriv audit all --url http://localhost:3000
pnpm exec hypdriv jobs run digest --url https://my-app.vercel.app
```

`hypdriv audit`, `bench` and `warm` sign their requests with a short-lived `x-hypdriv-audit` token (from `HYPDRIV_INTERNAL_SECRET`), so your own bot shield and rate limits do not block them; `--anonymous` audits as an anonymous visitor. On a deployment, the cache audit reads `x-vercel-cache`; locally it checks that the Vercel CDN headers are planned.

**Monorepos.** With the project's root directory set to the app (`apps/web`), `vercel link`, `vercel pull` and `vercel build` run at the repository root (a prebuilt deployment needs the workspace's `node_modules`). `hypdriv doctor`, `analyze` and `audit` find that link: the repository root's `.vercel/project.json` counts for the app it names as root directory, including the env files `vercel pull` wrote there and its `.vercel/output`.

**Private deployments.** Vercel Authentication can cover every deployment — production, `<project>.vercel.app` and custom domains included — on every plan (project setting *Deployment Protection → Vercel Authentication → All Deployments*, REST `ssoProtection: { deploymentType: 'all' }`). Tooling gets through with a *Protection Bypass for Automation* secret: `hypdriv audit`, `bench`, `warm` and `jobs run` send `VERCEL_AUTOMATION_BYPASS_SECRET` as `x-vercel-protection-bypass`, and Vercel exposes the same variable to the deployment so functions can call their own URL (`enqueue()`'s fallback uses it). Vercel Cron, Vercel Queues deliveries and the runtime logs are unaffected. BotID answers `bypassed` for requests that carry the bypass — by design, so your own automation is never challenged.

**Live verification.** [`e2e/vercel`](../../e2e/vercel/README.md) deploys an app with every capability on to a private Vercel project and verifies them through its behaviour (via the automation bypass) and the runtime-logs stream (41 checks, Hobby plan); see the [report](../testing/vercel-live-2026-10-31.md).

## Cloudflare and Vercel side by side

| Capability | Cloudflare Workers | Vercel |
| --- | --- | --- |
| Drivetrain stages | Worker shell (`hypdriv.worker.ts`) | Routing Middleware (`proxy.ts`) |
| Edge cache | Hypdriv store (Cache API / KV) with SWR, coalescing, negative caching | Vercel CDN via `Vercel-CDN-Cache-Control` (route headers, `withVercelCdn`; per-country variants on Route Handlers) |
| Tag purge | tag index + zone purge | Vercel CDN tag purge |
| Strict CSP for cached HTML | edge nonce injection (HTMLRewriter) | hash for static; `'unsafe-inline'` fallback for ISR, tag-revalidated prerenders and PPR shells |
| Exact rate limits | `HypDrivLimiter` Durable Object | Upstash Redis; Vercel WAF rules |
| Bot verdicts | Bot Management scores, Turnstile | heuristics, BotID |
| Flags / redirects / maintenance store | Workers KV | Global Config or Upstash Redis |
| Cron | Cron Triggers → `scheduled` | Vercel Cron → `GET` with `CRON_SECRET` (Hobby: daily) |
| Queues | Cloudflare Queues (retries, dead-letter queue) | Vercel Queues (retries; no dead-letter queue: `retry: 'none'` acknowledges) |
| Live channels | `HypDrivChannel` Durable Object (SSE / WebSocket) | polling transport |
| Early Hints | 103 responses from `Link` headers | `Link` preload headers (Vercel sends no 103) |
| Images | Cloudflare Images loader | Vercel Image Optimization |

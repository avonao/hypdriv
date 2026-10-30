# HypDriv on Vercel

On Vercel, HypDriv runs where Vercel runs your code: the Drivetrain stages in **Routing Middleware** (`proxy.ts`), server helpers in **Vercel Functions**, and the build integration in `next build` (`withHypDriv` and the chained adapter). There is no Worker entry and no extra infrastructure: platform services — the Vercel CDN, Upstash Redis, Global Config, the Vercel WAF, BotID, Vercel Queues — are upgrades HypDriv detects from the environment, exactly like bindings on Cloudflare.

Vercel is detected automatically (`VERCEL=1` during builds and in functions, a `vercel.json` / `.vercel` directory locally); set `platform: 'vercel'` in `hypdriv.config.ts` to make it explicit. US-first: the examples deploy to `iad1`; add an EU region (`fra1`, `cdg1`) only where EU operations require it.

## New project

```sh
npm create hypdriv@latest my-app -- --platform vercel            # add --purser for Purser CSS
cd my-app
pnpm dev                 # next dev: proxy.ts runs the HypDriv stages
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

`revalidateTag()` / `purgeEdge()` from `hypdriv/cache` purge Vercel's CDN on Vercel. `/_hypdriv/health` lists the services in use.

## Caching on Vercel

Vercel runs Routing Middleware **before** its CDN cache, and the cache stores what the **function** returns, so headers set in `proxy.ts` reach the browser but do not make Vercel cache anything. HypDriv therefore puts the CDN headers where Vercel's cache reads them:

- **Pages** — `withHypDriv` turns explicit edge-cache policies into `next.config` `headers()` rules (they show up in `.vercel/output/config.json`). Only policies whose meaning survives static route headers are emitted: `respectOrigin: false`, no `Vary` needs, translatable patterns. The build log lists the rest with the reason.
- **Route Handlers** — wrap them with `withVercelCdn` (same planning and verdict as the stage, reads `.hypdriv/manifest.json` for route and build tags):

  ```ts
  // app/api/products/route.ts
  import { withVercelCdn } from 'hypdriv/vercel';
  import config from '@/hypdriv.config';
  export const GET = withVercelCdn(config, async () => Response.json(await listProducts()));
  ```

- **Prerendered and ISR pages** are cached by Vercel natively; HypDriv does not override them.

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

## CSP on Vercel

- **Static routes** get the hash-based policy from the build manifest (A+).
- **Dynamic routes** get a per-request nonce; Next.js applies it to its inline scripts.
- **ISR and PPR shells** are served from a cache that no per-request nonce can reach, and Vercel has no `HTMLRewriter` to inject one at the edge. HypDriv sends its documented fallback (`script-src 'self' 'unsafe-inline'` with every other directive strict, `x-hypdriv-csp: unsafe-inline-fallback`). `hypdriv audit csp` reports it as a warning with the options: render the route dynamically (`await connection()`), or serve it through the Cloudflare Worker for edge nonces.

## Jobs and queues

**Vercel Cron** calls job routes with `GET` and `Authorization: Bearer $CRON_SECRET`; `jobHandler` accepts it (and the signed requests of `hypdriv jobs run`):

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

**Vercel Queues** back `enqueue()` once `@vercel/queue` is registered; until then (and outside Vercel) `enqueue()` calls the consumer route directly with a request signed by `HYPDRIV_INTERNAL_SECRET` (through `VERCEL_URL`, with `VERCEL_AUTOMATION_BYPASS_SECRET` for protected deployments). Map HypDriv queue names to topics with `vercel.queues` and consume with `queueConsumer`:

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

## Platform SDKs

`@hypdriv/vercel` never imports Vercel SDKs; register the ones you use once per process (instrumentation is the natural place):

| SDK | Enables |
| --- | --- |
| `@vercel/firewall` (`checkRateLimit`) | `vercel.firewall.rateLimitRules` (WAF rate-limit rules per HypDriv policy) |
| `botid` (`checkBotId`) | `botIdGuard()` for `safeAction` and `verifyBotId()` |
| `@vercel/queue` (`send`, `sendBatch`, `handleCallback`) | `enqueue()` through Vercel Queues, `queueConsumer()` |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `HYPDRIV_SESSION_SECRET` | encrypted sessions, CSRF |
| `HYPDRIV_INTERNAL_SECRET` | signed internal requests (`enqueue()` fallback, `hypdriv jobs run`, audit tokens) |
| `CRON_SECRET` | Vercel Cron authentication |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | Upstash Redis: exact rate limits, read-write KV |
| `GLOBAL_CONFIG` (or `EDGE_CONFIG`) | Global Config: flags, redirects, maintenance switch |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | REST purge outside a Vercel request (CI, scripts) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | lets `enqueue()`'s fallback reach a protected deployment |

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_ID` and `VERCEL_DEPLOYMENT_ID` are system variables Vercel sets.

## Build integration

- **Legacy builder and adapter.** Vercel's builder reads `.next/server/app/**`; Next.js ≥ 16.4 writes prerenders to `.next/server/route-cache/**` whenever an adapter is configured. Because HypDriv installs an adapter, it restores the classic layout after the build (never overwriting files), so prerenders, ISR and PPR fallbacks reach `.vercel/output`. With Vercel's Next.js adapter enabled (`NEXT_ENABLE_ADAPTER=1`, which sets `NEXT_ADAPTER_PATH`), HypDriv chains it: Vercel's adapter receives the build unchanged plus the HypDriv manifest as an extra asset.
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

## Cloudflare and Vercel side by side

| Capability | Cloudflare Workers | Vercel |
| --- | --- | --- |
| Drivetrain stages | Worker shell (`hypdriv.worker.ts`) | Routing Middleware (`proxy.ts`) |
| Edge cache | HypDriv store (Cache API / KV) with SWR, coalescing, negative caching | Vercel CDN via `Vercel-CDN-Cache-Control` (route headers, `withVercelCdn`) |
| Tag purge | tag index + zone purge | Vercel CDN tag purge |
| Strict CSP for cached HTML | edge nonce injection (HTMLRewriter) | hash for static; `'unsafe-inline'` fallback for ISR / PPR shells |
| Exact rate limits | `HypDrivLimiter` Durable Object | Upstash Redis; Vercel WAF rules |
| Bot verdicts | Bot Management scores, Turnstile | heuristics, BotID |
| Flags / redirects / maintenance store | Workers KV | Global Config or Upstash Redis |
| Cron | Cron Triggers → `scheduled` | Vercel Cron → `GET` with `CRON_SECRET` |
| Queues | Cloudflare Queues | Vercel Queues |
| Live channels | `HypDrivChannel` Durable Object (SSE / WebSocket) | polling transport |
| Early Hints | 103 responses from `Link` headers | `Link` preload headers |
| Images | Cloudflare Images loader | Vercel Image Optimization |

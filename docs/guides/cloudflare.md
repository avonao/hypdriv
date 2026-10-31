# HypDriv on Cloudflare Workers

HypDriv runs inside the Worker that OpenNext generates. `hypdriv.worker.ts` becomes the Worker entry; it wraps `.open-next/worker.js`, runs the Drivetrain pipeline around it, answers HypDriv's internal routes and adds the `scheduled`, `queue`, `email` and `tail` handlers.

```ts
// hypdriv.worker.ts
import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from 'hypdriv/durable-objects';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),   // written by `next build` (the HypDriv adapter)
  // stages: (defaults, platform) => [...defaults, myStage],   // optional customisation
});
```

```jsonc
// wrangler.jsonc
{
  "main": "hypdriv.worker.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "observability": { "enabled": true }
}
```

`opennextjs-cloudflare build | preview | deploy` keep working unchanged: the build still writes `.open-next/worker.js`; wrangler bundles `hypdriv.worker.ts` and everything it imports.

## OpenNext's cache setup

OpenNext's defaults for the revalidation queue, the tag cache and cache purges are no-ops: without them, time-based ISR never regenerates a page and `revalidateTag()` / `revalidatePath()` change nothing on Cloudflare. The examples and the `create-hypdriv` templates ship the full setup; `hypdriv doctor` (`opennext.cache`) checks that each override has its binding and that the Worker entry exports its Durable Object.

```ts
// open-next.config.ts
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import purgeCache from '@opennextjs/cloudflare/overrides/cache-purge/index';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import { withRegionalCache } from '@opennextjs/cloudflare/overrides/incremental-cache/regional-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';
import doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';

export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: 'long-lived' }),
  queue: doQueue,
  tagCache: doShardedTagCache({ baseShardSize: 12 }),
  cachePurge: purgeCache({ type: 'durableObject' }),
});
```

```jsonc
// wrangler.jsonc (additions)
"r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "<app>-opennext-cache" }],
"services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "<worker name>" }],
"durable_objects": { "bindings": [
  { "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DOQueueHandler" },
  { "name": "NEXT_TAG_CACHE_DO_SHARDED", "class_name": "DOShardedTagCache" },
  { "name": "NEXT_CACHE_DO_PURGE", "class_name": "BucketCachePurge" }
] },
"migrations": [{ "tag": "opennext-v1", "new_sqlite_classes": ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"] }]
```

Set `CACHE_PURGE_ZONE_ID` and `CACHE_PURGE_API_TOKEN` (a token limited to Zone → Cache Purge) as secrets on custom domains: OpenNext's `BucketCachePurge` and HypDriv's edge cache both purge the zone by tag with them. On `*.workers.dev` the Cache API is a no-op, so the regional cache and HypDriv's Cache API tier only take effect on custom domains.

**ISR revalidation through the Worker.** OpenNext's queue regenerates stale pages by requesting them through `WORKER_SELF_REFERENCE` with `x-prerender-revalidate: <previewModeId>`. The HypDriv Worker recognises these requests by a SHA-256 of the build's preview-mode id stored in the manifest (`manifest.revalidation`; the id itself never leaves the build output), sends them straight to Next.js — no edge cache, bot shield or rate limit in between — and, when Next.js answers `x-nextjs-cache: REVALIDATED`, purges the page's edge-cache copies by its `path:` tag. A request carrying the header with any other value runs through the Drivetrain like every other request.

**Deployment ids.** Next.js 16 uses a constant `BUILD_ID` whenever `deploymentId` is set, and OpenNext keys its caches by the deployment id. HypDriv's default id is `<commit>-<build stamp>`, unique per build and per app ([ADR 0016](../adr/0016-deployment-ids-per-build.md)); never share one id between apps on the same zone (the Cache API is per zone) or between builds with different output.

## Request flow

1. Static assets are served by Cloudflare before the Worker runs (unless `run_worker_first` is set).
2. `createWorker.fetch` creates the request context (geo from `request.cf`, client IP, request id) and matches the route in the manifest. With `redirects.forceHttps` on (the default when `site.origin` is `https`), a plain-HTTP request gets its `308` here, before anything else answers — internal routes and static assets included.
3. Internal routes under `/_hypdriv/*` are answered immediately: `health`, `vitals`, `csp-report`, `live/*`, `dev/*` (development and preview only).
4. The pipeline's `pre` stages run; one of them may answer directly (maintenance page, rate limit, redirect, cache HIT, bot block).
5. OpenNext's worker renders through Next.js with the forwarded request headers (`x-nonce`, `x-hypdriv-geo`, `x-hypdriv-flags`, `x-hypdriv-locale`, `x-hypdriv-theme`, `x-hypdriv-request-id`, `traceparent`).
6. The `post` stages run in reverse order (store in the edge cache, inject nonce/speculation rules/theme classes with `HTMLRewriter`, set headers), then `Server-Timing` is added.
7. Background work (cache revalidation, trace export, vitals writes) runs in `ctx.waitUntil`.

## Bindings and what they unlock

Everything works with no bindings. Add bindings to upgrade behaviour; HypDriv detects them at startup (`detectCapabilities`).

| Binding (default name) | Wrangler key | Unlocks |
| --- | --- | --- |
| `ASSETS` | `assets` | required by OpenNext |
| `HYPDRIV_KV` | `kv_namespaces` | global cache tier, KV tag index, KV-managed redirects, maintenance flag, flags provider, idempotency store |
| `HYPDRIV_INDEX` → `HypDrivIndex` | `durable_objects` + `migrations` (`new_sqlite_classes`) | exact tag purge index |
| `HYPDRIV_LIMITER` → `HypDrivLimiter` | `durable_objects` | exact, global rate limiting and cross-isolate coalescing locks |
| `HYPDRIV_CHANNEL` → `HypDrivChannel` | `durable_objects` | live channels (SSE/WebSocket pub/sub) |
| `HYPDRIV_RATE_LIMIT` | `ratelimits` | Cloudflare's Rate Limiting binding (per colo, 10 s / 60 s windows) |
| `HYPDRIV_ANALYTICS` | `analytics_engine_datasets` | Web Vitals, CSP reports and traces stored in Analytics Engine (`hypdriv vitals`) |
| `IMAGES` | `images` | `/_next/image` through the Images binding (OpenNext) |
| queues (`cloudflare.bindings.queues`) | `queues.producers` / `consumers` | `enqueue()` and queue consumers dispatched to Route Handlers |
| `NEXT_INC_CACHE_R2_BUCKET` etc. | OpenNext's | ISR / Cache Components storage (see OpenNext docs) |

Durable Objects need a migration entry, e.g. `{"tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"]}`.

## Cron, queues, email

```ts
// hypdriv.config.ts
jobs: {
  cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } },
  queues: { emails: { path: '/api/queues/emails', retry: 'failed' } },
  email: { path: '/api/inbound-email' },
}
```

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["0 9 * * 1"] },
"queues": { "consumers": [{ "queue": "emails", "max_batch_size": 10 }], "producers": [{ "binding": "EMAILS", "queue": "emails" }] }
```

```ts
// app/api/jobs/digest/route.ts
import { jobHandler } from 'hypdriv/server';
export const POST = jobHandler({}, async ({ job, cron, payload }) => ({ ok: true }));
```

Queue names usually differ per environment (`shop-jobs-staging`, `shop-jobs`). Keep one logical name for `enqueue()` and list the deployed names the consumer receives batches from, `*` as a wildcard:

```ts
jobs: { queues: { jobs: { path: '/api/jobs/work', queues: ['*-jobs'] }, 'jobs-dead': { path: '/api/jobs/dead', queues: ['*-jobs-dlq'], retry: 'none' } } },
cloudflare: { bindings: { queues: { jobs: 'JOBS' } } },   // producer binding for enqueue('jobs', …)
```

Batches report both names to the route (`{ job: 'jobs', queue: 'shop-jobs-staging', messages }`). `hypdriv doctor` (`wrangler.queues`) flags consumer queues that map to no job (their batches would be retried into the dead-letter queue), jobs without a consumer and producer bindings missing from `queues.producers`.

The Worker signs internal requests with `HYPDRIV_INTERNAL_SECRET` (HMAC over timestamp, method, path and body hash, 5-minute window); `jobHandler` rejects anything else. Queue batches are posted as `{ job: '<queue>', messages: [...] }`; messages are acked or retried according to `retry` and the handler's response (`{ retry: ['id', ...] }` retries specific messages).

## Tail Workers

Every HypDriv Worker exports a `tail` handler. List it in another Worker's `tail_consumers` to receive that Worker's exceptions, `console.warn`/`console.error` lines and invocations that ended abnormally without an exception (`exceededCpu`, `exceededMemory`, `exceededWallTime`, `canceled`, …), logged as `tail exception`, `tail log` and `tail outcome` with the producer's script name, path or cron.

## Edge-cache purges across isolates and colos

`purgeEdge()`, `revalidateTag()` and `revalidatePath()` from `hypdriv/cache` delete the indexed entries in the isolate that runs them, purge the zone by tag when `CACHE_PURGE_ZONE_ID` / `CACHE_PURGE_API_TOKEN` are set (Cache API copies are stored with `Cache-Tag`, so every colo drops them), record purge tombstones in the tag index so a response requested before the purge is never stored afterwards, and purge once more two seconds later, after Next.js has applied the revalidation. Other isolates re-read the shared tiers within `cache.edge.memoryTtl` (default `10s`). Details: [ADR 0017](../adr/0017-purge-consistency.md).

## Private test and staging deployments

A custom domain is what unlocks the Cache API, Early Hints, zone purges and image resizing, so test Workers need one — and are then public unless something in front says otherwise:

- **Turn off `workers.dev`** (`"workers_dev": false`, `"preview_urls": false`): with a custom domain it is only a second, public door.
- **Cloudflare Access** (Zero Trust, free tier) puts a login in front of the hostname; give automation a service token. `hypdriv audit`, `bench`, `warm` and `jobs run` send `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` as `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
- **A zone WAF custom rule** (every plan, no Zero Trust needed) that blocks HTTPS requests to the hostname unless they carry a secret header or cookie — what `e2e/cloudflare`'s `provision --gate` creates. Leave plain HTTP out of the rule: the Worker answers it only with the `308` to HTTPS, so the secret never travels unencrypted. Tooling sends the header from `HYPDRIV_ACCESS_HEADERS` (`x-hypdriv-gate: …`) or `--header`.

Internal requests are unaffected by both: Cron Triggers, Queues, the tail consumer and OpenNext's revalidation (service binding) never cross the zone's edge, and image resizing's origin fetches pass the rule.

## Limits that matter

| Limit | Value | HypDriv |
| --- | --- | --- |
| Worker size | 64 MiB uncompressed (compressed size is not limited) | `hypdriv analyze` reports raw and gzip sizes and the largest modules |
| Startup | 1 s of global-scope execution | the shell loads OpenNext lazily; `analyze` flags heavy top-level work |
| CPU per request | 10 ms (free) / 30 s default, up to 5 min (paid) | `Server-Timing` shows stage costs; HTMLRewriter stages are O(bytes) |
| Subrequests | 50 (free) / 10,000 (paid) | cache stores and sinks batch writes; `hypFetch` dedupes |
| Cache API calls | 50 (free) / 1,000 (paid) per request | the edge cache performs at most one read and one write per request |

## Smart Placement and `run_worker_first`

HypDriv's edge stages are latency-sensitive and should stay at the edge; if you enable Smart Placement for database-heavy rendering, the whole Worker (including the shell) moves. Prefer Hyperdrive for database proximity. `run_worker_first` makes asset requests hit the Worker too; only enable it when you need HypDriv headers on static assets (the `_headers` file covers immutable caching without it).

## `next dev` and `wrangler dev`

- `next dev` runs the stages through `proxy.ts` (Node runtime). Edge-only stages (HTML transforms, nonce injection for cached HTML, edge cache storage) are skipped and the HUD shows `runner: proxy`.
- `pnpm preview` runs the real Worker locally with Miniflare; bindings declared in `wrangler.jsonc` are emulated. Put secrets in `.dev.vars`.
- Running `wrangler dev` yourself after `opennextjs-cloudflare build`? Populate the local incremental cache first (`opennextjs-cloudflare populateCache local`; `preview` does it for you). Without it, prerendered Cache Components pages have no cache entries in the local R2 bucket and render on demand.
- `hypdriv audit all --url http://127.0.0.1:8787` signs its requests with an audit token derived from `HYPDRIV_INTERNAL_SECRET` in `.dev.vars`, so the bot shield lets the headless-Chrome CSS audit through (`--anonymous` audits as a stranger would).
- `initOpenNextCloudflareForDev()` in `next.config.ts` exposes emulated bindings inside `next dev` so `hyp().env` works there too. Its platform proxy warns that the Worker's own Durable Objects (`HYPDRIV_CHANNEL`, `HYPDRIV_LIMITER`, `HYPDRIV_INDEX`) "will not work in local development": that applies to `next dev` only, where HypDriv uses in-memory counters, tag indexes and the polling live transport; `wrangler dev` and production run the Durable Objects.

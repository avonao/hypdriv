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

## Request flow

1. Static assets are served by Cloudflare before the Worker runs (unless `run_worker_first` is set).
2. `createWorker.fetch` creates the request context (geo from `request.cf`, client IP, request id) and matches the route in the manifest.
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

The Worker signs internal requests with `HYPDRIV_INTERNAL_SECRET` (HMAC over timestamp, method, path and body hash, 5-minute window); `jobHandler` rejects anything else. Queue batches are posted as `{ job: '<queue>', messages: [...] }`; messages are acked or retried according to `retry` and the handler's response (`{ retry: ['id', ...] }` retries specific messages).

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
- `initOpenNextCloudflareForDev()` in `next.config.ts` exposes emulated bindings inside `next dev` so `hyp().env` works there too.

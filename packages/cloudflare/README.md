# @hypdriv/cloudflare

The HypDriv Worker shell for [OpenNext](https://opennext.js.org/cloudflare) on Cloudflare Workers. It becomes your Worker entry, wraps `.open-next/worker.js` with the Drivetrain pipeline, answers HypDriv's internal routes and adds the `scheduled`, `queue`, `email` and `tail` handlers. It ships the `HypDrivLimiter` and `HypDrivIndex` Durable Objects and re-exports `HypDrivChannel` from `@hypdriv/live`.

## Setup

```ts
// hypdriv.worker.ts  (wrangler.jsonc → "main": "hypdriv.worker.ts")
import { createWorker } from '@hypdriv/cloudflare';
import config from './hypdriv.config';

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from '@hypdriv/cloudflare/durable-objects';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
```

`opennextjs-cloudflare build | preview | deploy` keep working: OpenNext still writes `.open-next/worker.js`, and wrangler bundles `hypdriv.worker.ts` with everything it imports. OpenNext is imported lazily on the first request that needs it, so Worker startup stays small.

## `createWorker(options)`

| Option | Description |
| --- | --- |
| `config` | HypDriv config (input or resolved) |
| `next` | `() => import('./.open-next/worker.js')` |
| `manifest` | the build manifest or a loader; a missing manifest degrades to generic behaviour with a warning |
| `stages` | `Stage[]` or `(defaults, platform) => Stage[]` |
| `onError` | custom response for unhandled errors (default: JSON 500 with the request id, message only in development) |
| `development` | force development behaviour (dev endpoints); default from `NODE_ENV`/`NEXTJS_ENV` or a localhost URL |
| `devState` | extra state for the DevTools endpoints |

Per request the shell creates the HypDriv context (geo from `request.cf`, client IP, request id), runs it through `AsyncLocalStorage` so `hyp()` and `enqueue()` see it inside Next.js, answers `/_hypdriv/*`, runs the stages around Next.js and, when Next throws, serves a stale cached copy if the route's policy allows `stale-if-error`.

### Bindings it detects

| Binding | Upgrade |
| --- | --- |
| `HYPDRIV_LIMITER` → `HypDrivLimiter` | exact, global rate limiting (`store: 'auto'` prefers it) and cross-isolate locks |
| `HYPDRIV_INDEX` → `HypDrivIndex` | exact tag purges of the edge cache (SQLite, 16 shards) |
| `HYPDRIV_KV` | KV cache tier, KV tag index, KV-managed redirects/maintenance/flags, `store: 'kv'` rate limits |
| `HYPDRIV_RATE_LIMIT` | Cloudflare's Rate Limiting binding (`store: 'binding'`) |
| `HYPDRIV_ANALYTICS` | Web Vitals, CSP reports and traces in Analytics Engine |
| `HYPDRIV_CHANNEL` → `HypDrivChannel` | live channels |
| `WORKER_SELF_REFERENCE` | internal job requests go through the full Worker |

Durable Objects need a migration: `{ "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }`.

## Internal routes

| Path | Purpose |
| --- | --- |
| `/_hypdriv/health` | build id, Next version, route count, detected capabilities (`no-store`) |
| `/_hypdriv/vitals` | Web Vitals beacon collector (`observe.vitals`) |
| `/_hypdriv/csp-report` | CSP violation reports (`security.csp.reportTo`) |
| `/_hypdriv/live/*` | live channels (SSE, WebSocket, polling) |
| `/_hypdriv/dev/{state,manifest,purser}` | DevTools data; development/preview only, or with `?token=` matching `HYPDRIV_DEVTOOLS_TOKEN` |

## Jobs: cron, queues, email, tail

`scheduled` dispatches each cron trigger to the matching `jobs.cron` routes (and warms `cache.warm.routes` on `cache.warm.cron`); `queue` posts a batch as `{ job, messages }` to `jobs.queues[queue].path` and acks or retries messages from the route's response (`{ retry: ['id'] }`); `email` posts the raw MIME message to `jobs.email.path` and rejects mail the route refuses with 4xx/5xx; `tail` forwards exceptions and warn/error logs to structured logs. Every internal request is signed with `HYPDRIV_INTERNAL_SECRET` (HMAC over timestamp, method, path and body hash) and verified by `jobHandler()` from `@hypdriv/next/server`.

`enqueue(name, body, options?)` sends to the queue bound in `cloudflare.bindings.queues[name]`; without the binding it invokes the consumer route in-process after the response, so code works on every plan.

## Other exports

`getHypContext()`, `runWithHypContext()`, `installContextStore()`, `cloudflareGeo()`, `edgeStages()` (`html-transforms`: comment stripping that keeps React's Suspense markers, whitespace collapsing that leaves `pre`/`textarea`/`script`/`style`/`code` alone; `priority-hints`: `fetchpriority="high"` on the likely LCP image), `internalRoutes()`, `dispatchScheduled/Queue/Email`, `forwardTail`, `createDoCounterStore`, `createDoTagIndex`, `createDoLock`, `callDurableObject` (RPC first, JSON `fetch` transport as fallback).

## Testing

`pnpm test` runs the Node suite and the workerd suite (`vitest.workers.config.ts`), which boots a Worker shaped like an application's `hypdriv.worker.ts` with both Durable Objects and exercises HTMLRewriter stages, Durable Object rate limiting and the SQLite tag index for real.

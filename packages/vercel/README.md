# @hypdriv/vercel

[HypDriv](https://github.com/avonao/hypdriv) on Vercel: edge-cache policies expressed as Vercel CDN headers with tag purge, Upstash Redis and Global Config (formerly Edge Config) as stores, Vercel WAF rate limits, BotID and Vercel Queues.

The package has **no runtime dependencies** besides `@hypdriv/*`. It talks to Vercel services over `fetch` (Upstash REST, the Global Config read endpoint, the purge REST API) or through Vercel's request-context global, and it never imports Vercel SDK packages: features that only exist in an SDK (`@vercel/firewall`, `botid`, `@vercel/queue`) are **registered** by your application, so an uninstalled package can never break your build. Runtime code uses Web APIs only and runs in Vercel Functions, Routing Middleware (`proxy.ts`) and any other runtime.

## Install

```sh
pnpm add @hypdriv/vercel
# optional, only for the features you use:
pnpm add @vercel/firewall botid @vercel/queue
```

## Setup

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  platform: 'auto', // detects Vercel from VERCEL=1; or 'vercel'
  cache: {
    edge: {
      policies: [
        { id: 'catalog', match: '/api/catalog/**', ttl: '5m', swr: '1h', tags: ['catalog'] },
        { id: 'pricing', match: '/pricing', ttl: '10m', swr: '1d', respectOrigin: false },
      ],
    },
  },
  security: { rateLimit: [{ id: 'login', match: '/login', methods: ['POST'], limit: 5, window: '10m' }] },
  vercel: {
    cdn: { downstream: false }, // true: also emit CDN-Cache-Control for a CDN in front of Vercel
    firewall: { rateLimitRules: { login: 'login-attempts' } }, // HypDriv policy id → WAF rule id
    botId: { checkLevel: 'basic' },
    queues: { emails: 'transactional-email' }, // HypDriv queue name → Vercel Queues topic
  },
});
```

When `@hypdriv/next` detects Vercel it applies `vercelEnv`, `vercelPlatformOverrides` and `vercelStages` itself. For a hand-built pipeline:

```ts
// proxy.ts
import { createProxy } from '@hypdriv/next/proxy';
import { vercelEnv, vercelPlatformOverrides, vercelStages } from '@hypdriv/vercel';
import config from './hypdriv.config';

const env = vercelEnv(config, process.env);
export default createProxy(config, vercelStages(config), { platform: vercelPlatformOverrides(config, env) });
```

Register the SDK functions you use once per process:

```ts
// instrumentation.ts
import { checkRateLimit } from '@vercel/firewall';
import { checkBotId } from 'botid/server';
import { handleCallback, send, sendBatch } from '@vercel/queue';
import { registerVercelSdk } from '@hypdriv/vercel';

export async function register() {
  registerVercelSdk({ checkRateLimit, checkBotId, queue: { send, sendBatch, handleCallback } });
}
```

Registrations merge, so different modules can register different packages. `getVercelSdk()` returns what is registered.

## Environment variables

| Variable | Used for | Default config key |
| --- | --- | --- |
| `GLOBAL_CONFIG`, then `EDGE_CONFIG` | Global Config connection string (read-only KV) | `vercel.globalConfig.connectionEnv` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`, then `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis (KV, exact global rate-limit counters) | `vercel.redis.urlEnv` / `tokenEnv` |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | REST fallback for tag purges outside a Vercel request | `vercel.purge.*Env` |
| `VERCEL_ENV` | REST purge target (`production` / `preview`) | — |
| `CRON_SECRET` | Vercel Cron authentication (handled by `@hypdriv/next`'s `jobHandler`) | `vercel.cronSecretEnv` |

`VERCEL_PROJECT_ID` is a system variable Vercel sets on every deployment; it is used whenever the configured project variable is empty.

## CDN caching

`vercelCdnStage(config)` replaces the `edge-cache` stage (same name, so `stages.disable` / `stages.order` keep working). It does not store responses: it expresses the matched policy (explicit, or inferred from the manifest for static and ISR routes) as headers Vercel's CDN understands:

```
Vercel-CDN-Cache-Control: s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400
Vercel-Cache-Tag: hyp:path:/api/catalog/shoes,catalog,build:b1
Vary: Accept-Language
```

- **Tags**: the policy's tags, `route:<id>` and `build:<id>`, plus `hyp:route:<routeId>` and `hyp:path:<pathname>`. Tags are sanitised exactly like the purger sanitises them (commas, whitespace and non-ASCII percent-encoded, at most 256 bytes, at most 128 per response).
- **Vary**: `vary.headers`, bypass headers, `vary.geo` (`X-Vercel-IP-Country`, `-Country-Region`, `-City`, `-Continent`, `-Timezone`; `colo` needs nothing because Vercel's cache is regional), `vary.language` (`Accept-Language`, plus `X-Vercel-IP-Country` when `i18n.geoMap` is set) and `vary.device` (`Sec-CH-UA-Mobile` and `User-Agent`, because HypDriv falls back to the user agent when browsers send no client hints).
- **Not expressible** on Vercel's CDN (URL plus `Vary` request headers is the whole cache key, and `Vary: Cookie` makes a response uncacheable): `vary.cookies`, `vary.flags`, `bypass.cookies`, `bypass.when`, and `vary.language` with the `cookie` i18n strategy. Such policies get no CDN headers, a `cache;desc=BYPASS` Server-Timing marker and a one-time warning.
- **Per request**: non-GET/HEAD, `Authorization`, bypass headers/query and RSC requests of `includeRsc: false` policies are not cached. After the response: `Set-Cookie` (also one queued by an earlier stage or the pending flags cookie), uncacheable statuses, `Vary: *`/`Cookie` and, with `respectOrigin`, an origin `no-store`/`private`/`no-cache` drop the headers; shorter origin lifetimes win; 404/410 get `cache.edge.negativeTtl`.
- The decision is in `ctx.state.get(CDN_DECISION_KEY)` (`CDN`, `BYPASS` or `DYNAMIC`) and in the `cache` Server-Timing marker.

### Where the headers must be set

Vercel runs Routing Middleware (`proxy.ts`) **before** its CDN cache, and middleware cannot set the CDN's caching headers: the function response is what gets cached. The stage still runs in `proxy.ts` (headers reach the client, and `CDN-Cache-Control` reaches a CDN in front of Vercel), and two helpers put the same headers where Vercel's cache reads them:

**Route Handlers** — wrap them; the planning and the response verdict are the stage's:

```ts
// app/api/catalog/[slug]/route.ts
import { withVercelCdn } from '@hypdriv/vercel';
import manifest from '@/.hypdriv/manifest.json';
import config from '@/hypdriv.config';

export const GET = withVercelCdn(config, async (request) => Response.json(await loadCatalog(request)), { manifest });
```

**Pages** — `vercelCdnRouteHeaders(config)` turns explicit policies into `next.config` `headers()` rules (`withHypDriv` merges them on Vercel):

```ts
const { rules, skipped } = vercelCdnRouteHeaders(config);
// rules: [{ source: '/pricing', headers: [{ key: 'vercel-cdn-cache-control', value: 's-maxage=600, …' }, …] }]
```

Only policies whose meaning survives static route headers are emitted: `respectOrigin: false` (with `respectOrigin`, the page's own `Cache-Control` already drives Vercel's CDN, and route headers could not honour a page's `private`), no `Vary` needs (a function's own `Vary` replaces route-level values), translatable patterns (`:param`, `:param*`, `/**`, `*`; not regular expressions or query patterns). Bypass query parameters and `includeRsc: false` become `missing` conditions. Static headers apply to every status, so `negativeTtl` does not apply there. Prerendered and ISR output is cached by Vercel natively, so inferred policies are not emitted. Everything left out is listed in `skipped` with the reason.

## Purge

```ts
import { deleteTags, invalidateTags, vercelPurger } from '@hypdriv/vercel';

await invalidateTags(['catalog']); // stale-while-revalidate on the next request
await deleteTags(['catalog'], { revalidationDeadlineSeconds: 60 }); // foreground revalidation
const purger = vercelPurger({ env: process.env, config }); // EdgePurger: purgeTags / purgeUrls → counts
```

Inside a Vercel Function or Middleware, the request-context purge API is used (what `@vercel/functions` `invalidateByTag` / `dangerouslyDeleteByTag` call; purges the running deployment's environment). Elsewhere, or when it fails, the REST API (`POST https://api.vercel.com/v1/edge-cache/invalidate-by-tags` / `dangerously-delete-by-tags`) with `VERCEL_TOKEN` and the project id. Tags are sent 16 per call; a 429 is retried once after `Retry-After` (up to 10 s). Purges never throw: failures are logged and the result is the number of tags purged. `purgeUrls` purges the `hyp:path:<pathname>` tag of each URL.

`vercelPlatformOverrides().purger` is the same purger adapted to the platform's `Purger` slot; `edgePurger` keeps the counts for `registerEdgePurger`.

## Stores

**`upstashKv({ url, token, prefix? })`** — a Workers-KV-compatible namespace over Upstash REST (strongly consistent). Text is stored as-is (values written by other Redis clients read normally), binary as base64 behind a type marker, `expirationTtl` → `EX`, `expiration` → `EXAT`. Redis has no per-key metadata, so `metadata` is not persisted. `list()` uses `SCAN … MATCH <prefix>* COUNT` and may return slightly more keys than `limit` per page.

**`upstashCounterStore({ url, token })`** — exact, global rate-limit counters: fixed and sliding windows in one pipeline (`INCR` + `PEXPIRE … NX`, plus `GET` of the previous window), token buckets in an atomic Lua script (`EVALSHA`, falling back to `EVAL`). Keys: `<prefix>rl:<key>:<windowStart>` and `<prefix>rl:<key>:bucket`.

**`globalConfigKv(connectionString)`** — read-only KV over Global Config's low-latency read endpoint (`GET /<id>/item/<key>?version=1` with the read token). `get(key, 'json')` returns the stored value, `get(key)` a string (JSON-stringified for non-strings), missing keys `null`. Reads are cached per key (`cacheTtlMs`, default 1 s), concurrent reads share one request, and the last known value is served while the endpoint fails. Accepts `https://global-config.vercel.com/<id>?token=…`, legacy `https://edge-config.vercel.com/ecfg_…?token=…` and `edge-config:id=…&token=…`. `put`/`delete` throw `E_UNSUPPORTED`: write items with the REST API or the dashboard.

**`vercelEnv(config, env)`** returns `env` plus the generic KV binding (`cloudflare.bindings.kv`, and the flags/redirects/maintenance KV bindings): Global Config when a connection string exists (flags, redirects and the maintenance switch only read), otherwise Upstash; plus `HYPDRIV_REDIS` (Upstash, read-write) when Redis is configured. Existing bindings are never replaced.

**`vercelPlatformOverrides(config, env)`** for `createPlatform`: capabilities over the augmented env, Upstash as the default and `kv` counter store when configured (with read-only Global Config as the KV binding and no Redis, `kv` counters fall back to memory, with a warning), the WAF binding, the purger, and a memory cache store when the KV binding is read-only.

## WAF rate limits

Map HypDriv policies to [Vercel WAF rate-limit rules](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) whose condition is a `@vercel/firewall` rule id:

- `vercelRateLimitStage(config)` (`rate-limit-vercel`, inserted after `rate-limit` by `vercelStages`) checks every mapped policy that applies to the request, concurrently and with the request (host and client IP), and answers with the policy's 429 response (`Retry-After`, `RateLimit-*`) when the WAF limits it. The local `rate-limit` stage still counts the policy too.
- Policies with `store: 'binding'` go to the WAF through the platform binding (`vercelRateLimitRouter`: the policy's rule, else the first rule) and are skipped by the stage.
- `vercelRateLimitBinding(ruleId, { request })` is the plain `RateLimitBindingLike`.

Unknown rules (`not-found`), WAF errors and a missing SDK fail open and are logged.

## BotID

```ts
import { botIdGuard, verifyBotId } from '@hypdriv/vercel';
import { safeAction } from '@hypdriv/security';

export const checkout = safeAction({ input: schema, guards: [botIdGuard({ allowVerifiedBots: false })], handler });
const verdict = await verifyBotId({ checkLevel: 'deepAnalysis' }); // null when BotID is not registered
```

The guard returns `ActionError('FORBIDDEN')` for bots (verified bots only pass with `allowVerifiedBots`). When BotID is unavailable it denies in production and allows in development (`onUnavailable` overrides). Add `initBotId()` from `botid/client/core` for the protected paths on the client.

## Queues

```ts
// producer
import { vercelQueue } from '@hypdriv/vercel';
await vercelQueue('emails', config).send({ to: 'ada@example.com' }, { delaySeconds: 60 });

// consumer: app/api/jobs/emails/route.ts
import { queueConsumer } from '@hypdriv/vercel';
export const POST = queueConsumer(async ({ job, messages }) => {
  const failed = await deliver(messages);
  return { retry: failed.map((m) => m.id) };
}, { config });
```

```json
// vercel.json
{ "functions": { "app/api/jobs/emails/route.ts": { "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "transactional-email" }] } } }
```

The consumer receives the same `{ job, messages: [{ id, timestamp, body, attempts }] }` input the Cloudflare `dispatchQueue` posts (one message per Vercel delivery) and the same retry contract: ids in `retry` are redelivered (5 s doubling to 15 min, `retryDelaySeconds` overrides), thrown errors follow Vercel's default retry, `jobs.queues[name].retry: 'none'` acknowledges instead. In local development `@vercel/queue` discovers consumers by the file that calls `handleCallback`; there, call it in the route file with `handleCallback(...toQueueCallback(consumer, { config }))`. Vercel Queues is in beta.

## Cloudflare ↔ Vercel

| HypDriv capability | Cloudflare | Vercel |
| --- | --- | --- |
| Edge cache | `edge-cache` stage storing in Cache API / KV | `vercelCdnStage` + `withVercelCdn` + `vercelCdnRouteHeaders` → Vercel CDN |
| Tag purge | tag index + zone purge (`Cache-Tag`) | `Vercel-Cache-Tag` + request-context / REST purge |
| KV (flags, redirects, maintenance) | Workers KV | Global Config (read-only) or Upstash Redis |
| Exact rate-limit counters | `HypDrivLimiter` Durable Object | Upstash Redis (`upstashCounterStore`) |
| Platform rate limiting | Rate Limiting binding | Vercel WAF (`@vercel/firewall`) |
| Bot verdicts | `request.cf.botManagement`, Turnstile | BotID (`botid`) |
| Queues | Queues binding + `dispatchQueue` | Vercel Queues (`vercelQueue`, `queueConsumer`) |
| HTML streaming transforms | HTMLRewriter (`html-transforms`) | not available (stage removed) |

## Limits

- Cache tags: 256 UTF-8 bytes each (quotes and backslashes count escaped), 128 per response, 16 per purge call. Purges from functions are rate limited per plan (Hobby 50/s per team, Pro 200/s per team, Enterprise 500/s per project).
- Vercel caches `200`, `301`, `302`, `307`, `308`, `404` and `410` responses of `GET`/`HEAD` requests without `Authorization` or `Range`, up to 10 MB (20 MB streamed), for at most one year.
- Global Config keys match `^[\w-]+$` (up to 256 characters); other keys read as `null`.
- Vercel Queues payloads are JSON-serialised by the SDK.

# @hypdriv/cache

The HypDriv edge cache engine: a full-response cache that sits in front of Next.js in the Drivetrain pipeline (`edge-cache` stage) and complements Next's own caches. Policies come from `hypdriv.config.ts` and from the build manifest, keys are normalised and hashed, entries live in memory, the Workers Cache API or KV, and the stage handles stale-while-revalidate, stale-if-error, negative caching, request coalescing, `Cache-Tag`/`Surrogate-Key` emission and tag/URL purges.

Runtime-neutral: no Node built-ins, no Cloudflare types. Workers-specific stores are detected at run time (ADR 0004).

## Install

```sh
pnpm add @hypdriv/cache @hypdriv/core
```

Most applications never import this package directly: `@hypdriv/next` (`createProxy`, `createPlatform`) and `@hypdriv/cloudflare` (`createWorker`) wire it from `hypdriv.config.ts`. Import it to build a custom runner, a custom store, or to purge from application code.

## Quick start

```ts
import { createEdgeCache, createMemoryTagIndex, createZonePurger, selectStore, UPSTREAM_KEY } from '@hypdriv/cache';
import { createContext, detectCapabilities, resolveConfig, runPipeline } from '@hypdriv/core';

const config = resolveConfig({ cache: { edge: { policies: [{ match: '/blog/:slug', ttl: '5m', swr: '1d' }] } } });
const caps = detectCapabilities(env, config);
const edgeCache = createEdgeCache({
  store: selectStore(config.cache.edge!.store, caps, env, config),
  tagIndex: createMemoryTagIndex(),
  purger: env.CACHE_PURGE_API_TOKEN
    ? createZonePurger({ zoneId: env.CACHE_PURGE_ZONE_ID!, token: env.CACHE_PURGE_API_TOKEN })
    : undefined,
  config,
  manifest,
});

export default {
  async fetch(request, env, execCtx) {
    const ctx = createContext({ request, config, manifest, env, waitUntil: (p) => execCtx.waitUntil(p), runner: 'worker' });
    ctx.state.set(UPSTREAM_KEY, (req) => nextWorker.fetch(req, env, execCtx));
    const { response } = await runPipeline({
      stages: [edgeCache.stage()],
      ctx,
      next: (req) => ctx.state.get(UPSTREAM_KEY)!(req),
    });
    return response;
  },
};
```

## Runner contract: `UPSTREAM_KEY`

`UPSTREAM_KEY` is a `StateKey<(request: Request) => Promise<Response>>`. Runners **must** set it to the upstream render function before running the pipeline. The stage uses it for background revalidation; when the runner also reads it at call time (as above), the stage wraps it per request so that:

- an upstream exception is answered with a stale-if-error entry (`ERROR-STALE`) when one exists;
- coalesced followers are released immediately when the leader fails.

Runners that call `next` directly keep stale-while-revalidate but should call `edgeCache.recover(ctx)` in their error handler to get stale-if-error on exceptions. Without `UPSTREAM_KEY`, stale entries are still served (`STALE`, reason `swr:no-upstream`) but never revalidated.

## Decision matrix

The stage writes `CACHE_DECISION_KEY` (`{ status, reason, policy?, key?, age?, tags? }`) for every request and records a `cache;desc=<status>` Server-Timing marker.

| Status        | When                                                                                     | Response headers                                  |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `DYNAMIC`     | cache disabled, method not GET/HEAD, no policy for the route                             | `x-hypdriv-cache` only                            |
| `BYPASS`      | bypass cookie/header/query/`when`, request `Cache-Control: no-cache`, `Authorization`, RSC with `includeRsc: false`, policy without lifetime | `x-hypdriv-cache` only |
| `MISS`        | nothing usable cached; the response is streamed to the client and stored in `waitUntil`  | `x-hypdriv-cache: MISS`, `Cache-Tag`, `Surrogate-Key`, `Vary`, default `Cache-Control` |
| `HIT`         | fresh entry (`age < ttl`), or a coalesced follower (`reason: coalesced`)                 | + `Age`                                           |
| `STALE`       | `ttl ≤ age < ttl + swr`; one background revalidation per key per isolate                 | + `Age`                                           |
| `ERROR-STALE` | upstream 5xx or exception while an entry is within `staleIfError`                        | + `Age`                                           |
| `NEGATIVE`    | fresh cached 404/410 (`negativeTtl`)                                                     | + `Age`                                           |
| `REVALIDATED` | logged by the background revalidation                                                    | —                                                 |

`reason` values: `fresh`, `coalesced`, `swr:revalidating`, `swr:in-flight`, `swr:no-upstream`, `negative`, `store`, `store:negative`, `cookie:<name>`, `header:<name>`, `query:<name>`, `when`, `no-cache`, `authorization`, `rsc`, `zero-ttl`, `method:<M>`, `no-policy`, `disabled`, `upstream:<status>`, `upstream:error`, `coalesced:fallthrough`, and `uncacheable:<why>` for responses the stage saw but did not store.

### What is stored

A MISS response is stored when all of these hold (`cacheability()`):

| Check                       | Behaviour                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| method                      | HEAD responses are served from cache but never stored                                              |
| `policy.statuses`           | default `200, 203, 204, 301, 308, 404, 410`; 404/410 use `negativeTtl` (swr/sie 0), `0` disables  |
| `Set-Cookie`                | never stored                                                                                       |
| `Vary: *`                   | never stored                                                                                       |
| origin `Cache-Control`      | with `respectOrigin` (default): `no-store`, `private`, `no-cache` skip; `s-maxage`/`max-age` cap the TTL (`0` skips); `stale-while-revalidate`/`stale-if-error` cap swr/sie; `must-revalidate`/`proxy-revalidate` disable stale serving |
| size                        | `content-length` or the streamed body above `maxBodySize` (default 5 MB) is not stored             |

The stored copy is captured in `post`, i.e. after later stages (CSP, security headers, Early Hints, HTML transforms) ran, minus volatile headers (`Set-Cookie`, `Age`, `Server-Timing`, `x-hypdriv-*`, `Cache-Tag`, request ids). HIT responses still pass through `post` stages, so those stages must be idempotent (they are in HypDriv). Responses without an origin `Cache-Control` get `cacheControlFor(policy)` = `public, max-age=0, s-maxage=<ttl>, stale-while-revalidate=<swr>, stale-if-error=<sie>` (zero directives omitted).

Do not put a cache policy on routes that use nonce-based CSP: the cached HTML contains the nonce of the request that rendered it. HypDriv's inferred policies only cover `static`, `isr` and (opt-in) `shell` routes, which receive hash-based CSP.

## Keys

`buildCacheKey(input)` hashes (SHA-256, base64url) a deterministic serialisation of:

- method (HEAD keys like GET) and the URL normalised by `normalizeUrl` from core: lowercase host, default ports removed, duplicate slashes collapsed, trailing slash per Next's `trailingSlash`, query sorted with `cache.edge.ignoredQuery` removed and `policy.keyQuery` (`'all' | 'none' | string[]`) applied;
- vary dimensions in a fixed order: headers (lowercased values), listed cookies (`name=value`), geo fields from `request.cf`, listed flags, locale (`vary.language`), device class (`vary.device`);
- the RSC markers `rsc`, `next-router-state-tree`, `next-router-prefetch`, `next-url` when the request is an RSC payload fetch;
- the build id, so a deployment never serves the previous build's entries.

It returns `{ key, vary, url }`: `vary` lists the request header names the key depends on (emitted as `Vary`); `url` is `https://hypdriv.cache/<key>`, usable with the Cache API. `serializeCacheKey()` exposes the unhashed material for tooling.

Flags, locale and device are owned by other packages; the stage reads them through `EdgeCacheOptions.resolvers` (`flags`, `locale`, `device`). Defaults: a state entry named `flags` or a JSON `x-hypdriv-flags` request header; the `x-hypdriv-locale` request header or `Accept-Language` negotiation; `Sec-CH-UA-Mobile` / user agent.

## Policies

`resolvePolicies(config, manifest)` returns explicit policies (config order, `source: 'explicit'`) followed by inferred ones (`source: 'inferred'`, most specific first per core's `patternSpecificity`) when `cache.edge.infer` is on:

| Classification | Inferred policy                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `static`       | `inferred:<routeId>`, `inferredStatic` ttl/swr/staleIfError, tag `route:<routeId>`                |
| `isr`          | same, with `ttl = min(inferredStatic.ttl, route.prerender.revalidate)`                            |
| `shell`        | only with `inferredShell` (`ttl`, `swr`, no stale-if-error)                                       |
| others         | none (dynamic routes are bypassed unless an explicit policy matches)                              |

Next.js pathnames become core patterns: `[slug]` → `:slug`, `[...path]` → `:path*`, `[[...slug]]` → `['/shop', '/shop/:slug*']`, groups and slots removed. `matchPolicy(policies, ctx)` checks the route's precomputed `cachePolicyId`, then explicit policies by pattern (so explicit wins), then the inferred policy of `ctx.route` (a `Map` by route id), then inferred patterns.

Effective tags of an entry: `policy.tags` + `route:<routeId>` + `build:<buildId>`.

## Stores

| Store                          | Scope        | Notes                                                                                                                   |
| ------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `createMemoryStore(options)`   | per isolate  | LRU by entries and approximate bytes; bodies buffered to `ArrayBuffer`; the Node/dev baseline                           |
| `createCacheApiStore(options)` | per colo     | `caches.default` (or `caches.open(cacheName)`); meta in `x-hypdriv-meta`; stored copy carries `cache-control: public, s-maxage=<ttl+swr+sie>` and restores the origin's `Cache-Control`/`Expires` on read; `Set-Cookie` never stored |
| `createKvStore(kv, options)`   | global       | framed value (`HYPC` + envelope JSON + body) because KV metadata is capped at 1 KB; `expirationTtl = max(60, lifetime)`; the freshness check on read handles shorter lifetimes |
| `createTieredStore(stores)`    | composed     | read-through with backfill of upper tiers, write-through, delete everywhere                                             |

`selectStore(kind, caps, env, config)`: explicit kinds when their capability exists (otherwise the next best), `auto` → tiered memory → Cache API → KV when KV is bound, Cache API when available, memory otherwise.

`CacheStore.set()` consumes the entry's response body (pass a clone if you still need it); `get()` returns a fresh `Response` each time. Store errors are caught by the stage (lookup failures become misses, write failures are logged).

## Tag index and purge

- `createMemoryTagIndex()` — exact within the isolate, bounded.
- `createKvTagIndex(kv)` — one KV key per tag with a bounded JSON list; adds from one isolate are batched (default 1 s window, matching KV's one write per key per second) and best effort. `remove(keys)` is a no-op (no reverse index); `removeTags(tags)` drops lists after a purge. `build:*` tags are never indexed.
- `createZonePurger({ zoneId, token })` — Cloudflare `POST /zones/:id/purge_cache` by `tags` or `files`, batched by 30, errors logged and never thrown.
- `edgeCache.purgeTags(tags)` — keys from the index → `store.delete` → index cleanup → purger; returns the number of keys deleted locally.
- `edgeCache.purgeUrls(urls)` — rebuilds the base key (GET, no vary dimensions) with the policy of each URL, deletes it and asks the purger; relative URLs resolve against `site.origin` or the last seen origin. Variants (RSC payloads, vary dimensions) need a tag purge.

Without any index, purges are TTL/SWR bounded and the build id gives a hard reset on deploy (ADR 0004).

## Coalescing

Concurrent GET misses for one key in one isolate share the leader's render: followers wait (up to `coalesceTimeoutMs`, default 10 s) for the leader's buffered response and answer `HIT` with `reason: coalesced`. When the leader's response is not cacheable, the leader throws, the client aborts or the timeout passes, followers render themselves.

## Workers vs Node

| Topic              | Workers (`createWorker`)                                       | Node / `next dev` (`createProxy`)                              |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| default store      | Cache API, tiered with KV when bound                           | memory (per process)                                           |
| background work    | `ctx.waitUntil` → `ExecutionContext.waitUntil`                 | core's context collects promises; `flushContext(ctx)` in tests |
| geo dimensions     | `request.cf`                                                   | absent unless the runner supplies `cf`                         |
| body streaming     | tee: client streams, store buffers up to `maxBodySize`         | same                                                           |
| proxy runner       | —                                                              | the stage is not `edgeOnly`; it works in proxy for GET/HEAD    |

## Testing

`pnpm -F @hypdriv/cache test` runs the Node suite (keys, policies, stores, tag indexes, purger, the stage decision matrix) and the Workers suite inside workerd (`*.workers.test.ts`: Cache API round trip and a MISS → HIT → purge cycle through `caches.default`).

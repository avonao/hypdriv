# Caching

Next.js 16 already has two caches: the client router cache and the server-side caches behind `'use cache'` / ISR (stored by OpenNext in R2/KV with D1 or Durable Object tag caches). Hypdriv adds a third, in front of all of them: the **edge cache**, a full-response cache that runs in the Worker before Next.js is invoked.

```
browser ──► Cloudflare edge ──► [Hypdriv edge cache] ──► OpenNext/Next.js ──► 'use cache' / ISR stores
```

## Why a third cache

- A HIT costs no Next.js compute at all (no module evaluation, no React render), which is what keeps CPU time near zero on cached routes.
- It serves **stale-while-revalidate** and **stale-if-error** at the HTTP level, so a slow or failing origin never reaches users of cached routes.
- It coalesces concurrent misses into one render.
- It is keyed on what actually varies (geo, flags, locale, cookies you name), not on the full header set.

## Policies

```ts
cache: {
  edge: {
    policies: [
      { id: 'blog', match: '/blog/**', ttl: '10m', swr: '1d', staleIfError: '7d', tags: ['blog'] },
      { id: 'home', match: '/', ttl: '1m', swr: '1h', vary: { geo: ['country'], flags: ['newHero'] } },
      { id: 'search', match: '/search', ttl: '30s', keyQuery: ['q', 'page'] },
      { id: 'account', match: '/account/**', ttl: 0 },                // never cache
    ],
    infer: true,
    inferredStatic: { ttl: '5m', swr: '1d', staleIfError: '7d' },
  },
}
```

- Explicit policies win over inferred ones; first match wins.
- **Inference** uses the manifest: `static` routes (prerendered, no revalidation) get `inferredStatic`; `isr` routes get `min(inferredStatic.ttl, revalidate)`; `shell` routes are cached only with `inferredShell`; `dynamic` routes and Route Handlers are never inferred.
- `ttl: 0` disables caching for a pattern (useful to carve exceptions out of broad rules).
- `respectOrigin` (default `true`): `Cache-Control: private` or `no-store` from Next.js prevents storage; `s-maxage`/`max-age` lower than `ttl` shortens it.
- Responses with `Set-Cookie` are never stored.
- `includeRsc` (default `true`) caches the RSC payload requests of the route under separate keys.

## Keys

A key is the SHA-256 of: method · lowercase host · pathname (the trailing slash is kept as requested: `/legal` and `/legal/` are different entries, because with Next's `trailingSlash` one of them is a redirect to the other) · sorted query without tracking parameters (or `keyQuery` subset) · vary dimensions (headers, cookies, geo, flags — including every running A/B experiment unless the policy sets `vary.experiments: false` — locale, device) · RSC markers (`rsc`, `next-router-state-tree`, `next-router-prefetch`, `next-url`) · build id. Deployments never serve each other's content.

Bypass conditions skip the cache entirely: `bypass.cookies` (e.g. a session cookie), `bypass.headers`, `bypass.query` (e.g. `preview`), `bypass.when(input)`; requests carrying `Cache-Control: no-cache` are also bypassed.

### The edge cache answers before `middleware.ts`

On Cloudflare the pipeline runs in the Worker shell, before OpenNext executes the application's `middleware.ts`. A cache HIT never reaches the middleware, so a cached page skips whatever the middleware decides from the request: a pre-launch site gate that checks a cookie, a session redirect, preview mode, a rewrite by header. Inferred policies (every static and ISR route) would serve the page an unlocked visitor caused to be stored to everyone, gate or no gate.

List the cookies, headers and query parameters the middleware reads in `cache.edge.bypass`. It applies to every policy, inferred ones included; a request carrying any of them reads nothing from the cache and stores nothing in it:

```ts
cache: { edge: { bypass: { cookies: ['site_gate'], headers: ['x-preview'], query: ['preview'] } } }
```

`hypdriv doctor` (`cache.middleware`) warns when the build has a middleware, the edge cache has policies and nothing is listed. A site whose middleware decides on more than a few cookies can turn the HTML cache off (`cache.edge.infer: false`, no policies) and keep OpenNext's incremental cache, which sits behind the middleware.

## Statuses

Every response carries `x-hypdriv-cache` and a `cache` entry in `Server-Timing`:

| Status | Meaning |
| --- | --- |
| `HIT` | served from the edge cache within `ttl` |
| `STALE` | served from the edge cache within `swr`; a revalidation runs in the background |
| `MISS` | rendered and stored |
| `REVALIDATED` | background revalidation stored a new entry |
| `ERROR-STALE` | origin failed (5xx or exception); a stale entry within `staleIfError` was served |
| `NEGATIVE` | a 404/410 served from the negative cache (`negativeTtl`) |
| `BYPASS` | a policy matched but a bypass condition applied (reason in the header) |
| `DYNAMIC` | no policy applies |

`Age`, `Cache-Tag` and `Surrogate-Key` headers are emitted for CDN and debugging tools.

## Stores

| Store | Scope | When |
| --- | --- | --- |
| memory | per isolate | Node / tests / tiny deployments; in front of shared tiers it serves an entry for at most `memoryTtl` (default `10s`, `0` removes it) |
| Cache API | per colo | default on Workers; zero configuration; copies carry `Cache-Tag` so zone purges by tag reach every colo |
| KV | global, eventually consistent (≈60 s) | with `HYPDRIV_KV`; used as the lower tier of the tiered store |
| tiered | memory → Cache API → KV | automatic when KV exists |

Caching a dynamic page (one that reads cookies or headers) needs `respectOrigin: false` on its policy: Next.js marks such responses `private, no-store`. Pair it with a `vary` that captures what the page reads (`vary: { geo: ['country'] }` for a per-country page).

## Purging

```ts
import { revalidateTag, revalidatePath, purgeEdge } from 'hypdriv/cache';

await revalidateTag('blog');                 // Next.js revalidation + edge purge of tag `blog`
await revalidatePath('/blog/hello-world');   // Next.js + edge purge of the path
await purgeEdge({ tags: ['route:app:/'] });  // edge only
```

How exact a tag purge is depends on the tag index: memory (per isolate), KV (`HYPDRIV_KV`) or the `HypDrivIndex` Durable Object (exact). Without an index, purges rely on TTL/SWR bounds and the zone purge API (`CACHE_PURGE_ZONE_ID` + `CACHE_PURGE_API_TOKEN`). Every entry carries the tags `route:<routeId>`, `path:<pathname>` (every variant of a page) and `build:<buildId>` automatically.

A purge also records **tombstones** in the tag index: a response that was requested before the purge (or within `purgeGraceMs`, 5 s, after it, while Next.js is still applying the same revalidation) is dropped instead of cached when it arrives. `revalidateTag()` and `revalidatePath()` purge once more two seconds later. Across isolates, other isolates re-read the shared tiers within `memoryTtl`; across colos, the zone purge by tag removes the Cache API copies. See [ADR 0017](../adr/0017-purge-consistency.md).

### Purging a running deployment from outside

`hypdriv purge --url <base> --path /pricing | --tag <tag> | --all` calls the signed endpoint `POST /_hypdriv/purge` of the Worker, which runs the same purge as `purgeEdge()` and therefore clears every tier (memory, Cache API, KV) and the zone copies. Use it instead of a raw Cloudflare tag purge, which cannot reach the KV tier. See [the CLI guide](cli.md#purging-a-deployment).

## Warming

```ts
cache: { warm: { routes: ['/', '/blog', '/pricing'], onDeploy: true, cron: '*/30 * * * *' } }
```

`hypdriv warm --url https://www.example.com` fetches the routes (with `concurrency`); with `cron` the Worker's `scheduled` handler re-warms them.

## Interaction with Cache Components

`'use cache'` decides what is cacheable *inside* a render; the edge cache decides whether a render happens at all. Keep them aligned: use `cacheTag()` with the same tag names you purge (`revalidateTag` from `hypdriv/cache` clears both). For personalised shells, cache the shell only when the personalised parts stream after `connection()`/`cookies()` — `inferredShell` is off by default because many shells embed user-specific data in the resumed stream.

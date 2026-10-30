---
"@hypdriv/cache": minor
"@hypdriv/core": minor
"@hypdriv/cloudflare": minor
"@hypdriv/next": minor
---

Edge-cache purges are consistent across isolates, colos and in-flight requests (ADR 0017), found by the live Cloudflare suite:

- `cache.edge.memoryTtl` (default `10s`, `0` removes the tier) bounds how long an isolate's memory tier serves an entry in front of the Cache API / KV, so purges run in another isolate take effect.
- Cache API copies are stored with `Cache-Tag` (`cacheTagHeader()`), so zone purges by tag reach every colo.
- Every entry is tagged `path:<pathname>` (`pathTag()`); `purgeUrls()` and `revalidatePath()` purge it, removing every variant of a page locally, through the index and in every colo.
- Purge tombstones: `TagIndex.markPurged(tags, until)` and `add(key, tags, ttl, { fetchedAt })` → `{ stale }`. The edge cache drops a response requested before a purge (or within `purgeGraceMs`, default 5 s) instead of storing it. Implemented by the `HypDrivIndex` Durable Object, the memory index and the KV index.
- `revalidateTag()` / `revalidatePath()` from `hypdriv/cache` purge again after `REPURGE_DELAY_MS` (2 s), once Next.js has applied its deferred revalidation.
- The edge cache logs each purge (`edge-cache: purged` with tags, indexed and deleted counts).

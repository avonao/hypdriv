# ADR 0017 — Edge-cache purges are consistent across isolates, colos and in-flight requests

**Status:** accepted · **Date:** 2026-10-30 · Amends [ADR 0004](0004-zero-infra-baseline.md) (tiered store)

## Context

The tiered store (memory → Cache API → KV) passed every local test, but on a live account `revalidateTag()` left old pages at the edge:

- **Isolates.** A purge runs in one isolate. The memory tier of every other isolate kept its copy for the entry's whole lifetime (TTL + SWR).
- **Colos.** `cache.delete()` is local to one data centre. Cache API copies elsewhere survived; zone purges by tag could not reach them because the stored copies carried no `Cache-Tag`. `purgeUrls()` could not reach them either: the store keys are synthetic URLs, and only the base variant (no `Vary` dimensions) was deleted.
- **Requests in flight.** A response requested before the purge and stored after it was indexed and kept. Next.js applies `revalidateTag()` / `revalidatePath()` *after* the Route Handler or Server Action returns (`pendingWaitUntil`), so a request arriving between HypDriv's purge and Next's commit received the old page from Next and re-cached it at the edge for the full TTL. On the live account, a purge issued about a second after the first store missed the entry entirely: the index write had not landed yet.

## Decision

1. **Memory tier is short-lived** in front of shared tiers: `cache.edge.memoryTtl` (default `10s`, `0` removes the tier) bounds how long an isolate serves its own copy before re-reading the shared tiers. Alone (Node, no shared tier), memory keeps the full lifetime.
2. **Cache API copies carry `Cache-Tag`** with the entry's tags (`route:`, `path:`, policy tags, `build:`), so a zone purge by tag drops them in every colo. Purges reach the zone through the purger configured with `CACHE_PURGE_ZONE_ID` / `CACHE_PURGE_API_TOKEN`.
3. **Every entry has a `path:<pathname>` tag.** `purgeUrls()` and `revalidatePath()` purge it, which removes every variant of the page (locale, theme, geo, flags) locally, through the index, and in every colo.
4. **Purge tombstones.** `TagIndex.markPurged(tags, until)` records that the tags were purged; `add(key, tags, ttl, { fetchedAt })` answers `{ stale: true }` when the response was requested from upstream at or before `until`, and the stage deletes the entry it just wrote. `until` is the purge time plus `purgeGraceMs` (default 5 s), covering upstreams that apply the revalidation after the purge. The Durable Object index (`HypDrivIndex`, strongly consistent) and the memory index implement it; the KV index stores tombstones as KV keys (exact in the purging colo, eventually consistent elsewhere).
5. **Repeat purge.** `revalidateTag()` / `revalidatePath()` from `hypdriv/cache` purge again after `REPURGE_DELAY_MS` (2 s), once Next.js has applied the revalidation, for stores without a tombstone index.

## Consequences

- With the Durable Object index and zone-purge credentials, a purge is global within seconds and cannot be undone by a request that was already in flight. The live suite (`e2e/cloudflare`, check `revalidate-tag`) purges about a second after the first store and verifies the fresh page.
- After a purge, responses for the purged tags are served but not cached for `purgeGraceMs`.
- Without zone-purge credentials, Cache API copies in other colos expire with their TTL; without a tag index, purges rely on TTL/SWR plus the repeat purge (the zero-infrastructure baseline of ADR 0004).
- The KV tier remains eventually consistent (≈60 s); entries resurrected from KV into faster tiers are still subject to the tombstone check when they are written.

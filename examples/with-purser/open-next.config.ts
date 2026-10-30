import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import purgeCache from '@opennextjs/cloudflare/overrides/cache-purge/index';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import { withRegionalCache } from '@opennextjs/cloudflare/overrides/incremental-cache/regional-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';
import doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';

// The full production cache setup (https://opennext.js.org/cloudflare/caching):
// - incremental cache in R2 with a regional Cache API layer in front,
// - ISR time-based revalidation through a Durable Object queue (needs WORKER_SELF_REFERENCE),
// - revalidateTag()/revalidatePath() through a sharded Durable Object tag cache,
// - zone cache purge batched by a Durable Object (set CACHE_PURGE_ZONE_ID and CACHE_PURGE_API_TOKEN).
export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: 'long-lived' }),
  queue: doQueue,
  tagCache: doShardedTagCache({ baseShardSize: 12 }),
  cachePurge: purgeCache({ type: 'durableObject' }),
});

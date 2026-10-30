import type {
  CacheStoreKind,
  Capabilities,
  HypDrivEnv,
  KVNamespaceLike,
  ResolvedConfig,
} from '@hypdriv/core';
import type { CacheStore } from '../types';
import { createCacheApiStore } from './cache-api';
import { createKvStore } from './kv';
import { createMemoryStore } from './memory';
import { createTieredStore } from './tiered';

/** Memory tier sizing: generous when memory is the only store, small when it fronts the Cache API. */
const MEMORY_ALONE = { maxEntries: 1000, maxBytes: 64 * 1024 * 1024 };
const MEMORY_TIER = { maxEntries: 256, maxBytes: 16 * 1024 * 1024 };

/**
 * Picks the store for the current environment (ADR 0004): an explicit kind when its capability exists,
 * otherwise `auto` → tiered (memory → Cache API → KV) when KV is bound, Cache API when available,
 * memory as the baseline.
 */
export function selectStore(
  kind: CacheStoreKind,
  caps: Capabilities,
  env: HypDrivEnv,
  config: ResolvedConfig,
): CacheStore {
  const kv = caps.kv ? (env[config.cloudflare.bindings.kv] as KVNamespaceLike | undefined) : undefined;
  // In front of shared tiers the memory tier is short-lived (`cache.edge.memoryTtl`): purges run in one
  // isolate, and other isolates must not keep serving the purged copy from their memory.
  const memoryTtl = config.cache.edge?.memoryTtl ?? 10;
  const tiered = () => {
    const shared: CacheStore[] = [];
    if (caps.cacheApi) shared.push(createCacheApiStore());
    if (kv) shared.push(createKvStore(kv));
    const tiers: CacheStore[] = [];
    if (!shared.length) tiers.push(createMemoryStore(MEMORY_ALONE));
    else if (memoryTtl > 0) tiers.push(createMemoryStore({ ...MEMORY_TIER, maxAgeSeconds: memoryTtl }));
    tiers.push(...shared);
    return createTieredStore(tiers);
  };
  switch (kind) {
    case 'memory':
      return createMemoryStore(MEMORY_ALONE);
    case 'cache-api':
      return caps.cacheApi ? createCacheApiStore() : createMemoryStore(MEMORY_ALONE);
    case 'kv':
      if (kv) return createKvStore(kv);
      return caps.cacheApi ? createCacheApiStore() : createMemoryStore(MEMORY_ALONE);
    case 'tiered':
      return tiered();
    default:
      if (kv) return tiered();
      return caps.cacheApi ? createCacheApiStore() : createMemoryStore(MEMORY_ALONE);
  }
}

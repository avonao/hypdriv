import type { CacheEntry, CacheStore } from '../types';

/**
 * Read-through / write-through composition of stores, fastest first (memory → Cache API → KV).
 * A hit in a lower tier backfills every tier above it; writes and deletes go to all tiers.
 */
export function createTieredStore(stores: CacheStore[]): CacheStore {
  if (stores.length === 0) throw new RangeError('createTieredStore needs at least one store');
  if (stores.length === 1) return stores[0]!;
  return {
    name: `tiered(${stores.map((s) => s.name).join(',')})`,
    async get(key) {
      for (let i = 0; i < stores.length; i++) {
        let entry: CacheEntry | null = null;
        try {
          entry = await stores[i]!.get(key);
        } catch {
          continue;
        }
        if (!entry) continue;
        if (i === 0) return entry;
        const copies = cloneEntry(entry, i);
        await Promise.allSettled(
          copies.slice(0, i).map((copy, tier) => stores[tier]!.set(key, copy).catch(() => undefined)),
        );
        return copies[i]!;
      }
      return null;
    },
    async set(key, entry) {
      const copies = cloneEntry(entry, stores.length - 1);
      const results = await Promise.allSettled(copies.map((copy, tier) => stores[tier]!.set(key, copy)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length === results.length) throw failed[0]!.reason;
    },
    async delete(key) {
      await Promise.allSettled(stores.map((s) => s.delete(key)));
    },
  };
}

/** Returns `count + 1` entries sharing the body stream (the last one is the original). */
function cloneEntry(entry: CacheEntry, count: number): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (let i = 0; i < count; i++) out.push({ response: entry.response.clone(), meta: entry.meta });
  out.push(entry);
  return out;
}

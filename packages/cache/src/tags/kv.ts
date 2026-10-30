import type { KVNamespaceLike, Logger } from '@hypdriv/core';
import type { TagIndex } from '../types';

export interface KvTagIndexOptions {
  /** Key prefix (default `hypdriv:tag:`). */
  prefix?: string;
  /** Max keys kept per tag (default 1000; oldest dropped first). */
  maxKeysPerTag?: number;
  /** Window in which adds from one isolate are merged into a single write per tag (default 1000 ms; KV allows one write per key per second). */
  batchDelayMs?: number;
  now?: () => number;
  log?: Logger;
}

type TagList = Array<[key: string, expiresAt: number]>;

/**
 * KV-backed tag index: one key per tag holding a bounded JSON list of cache keys. Writes are batched
 * per isolate and best effort (concurrent isolates may lose an add); there is no reverse index, so
 * `remove(keys)` is a no-op and `removeTags(tags)` drops whole lists after a purge.
 */
export function createKvTagIndex(kv: KVNamespaceLike, options: KvTagIndexOptions = {}): TagIndex {
  const prefix = options.prefix ?? 'hypdriv:tag:';
  const maxKeysPerTag = Math.max(1, options.maxKeysPerTag ?? 1000);
  const batchDelayMs = Math.max(0, options.batchDelayMs ?? 1000);
  const now = options.now ?? (() => Date.now());
  const log = options.log;

  let batch: { tags: Map<string, Map<string, number>>; done: Promise<void> } | null = null;

  const readList = async (tag: string): Promise<TagList> => {
    try {
      const raw = (await kv.get(prefix + tag, 'json')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (e): e is [string, number] =>
          Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number',
      );
    } catch {
      return [];
    }
  };

  const flush = async (tags: Map<string, Map<string, number>>) => {
    await Promise.all(
      [...tags].map(async ([tag, adds]) => {
        try {
          const t = now();
          const merged = new Map<string, number>();
          for (const [key, expiresAt] of await readList(tag)) if (expiresAt > t) merged.set(key, expiresAt);
          for (const [key, expiresAt] of adds) {
            merged.delete(key);
            merged.set(key, expiresAt);
          }
          while (merged.size > maxKeysPerTag) merged.delete(merged.keys().next().value as string);
          const list: TagList = [...merged];
          const maxExpiresAt = Math.max(...list.map(([, e]) => e));
          await kv.put(prefix + tag, JSON.stringify(list), {
            expiration: Math.ceil(Math.max(t + 60_000, maxExpiresAt) / 1000),
          });
        } catch (err) {
          log?.warn('edge-cache: KV tag index write failed', { tag, error: (err as Error)?.message });
        }
      }),
    );
  };

  const tombstoneKey = (tag: string) => `${prefix}purged:${tag}`;

  /** Latest purge tombstone among the tags (epoch ms), 0 when none. */
  const purgedUntil = async (tags: string[]): Promise<number> => {
    const values = await Promise.all(
      tags.map(async (tag) => {
        try {
          const raw = await kv.get(tombstoneKey(tag), 'text');
          const n = typeof raw === 'string' ? Number(raw) : Number.NaN;
          return Number.isFinite(n) ? n : 0;
        } catch {
          return 0;
        }
      }),
    );
    return Math.max(0, ...values);
  };

  const enqueue = (key: string, tags: string[], ttl: number): Promise<void> => {
    const expiresAt = now() + Math.max(1, ttl) * 1000;
    if (!batch) {
      const pending = new Map<string, Map<string, number>>();
      const current = {
        tags: pending,
        done: new Promise<void>((resolve) => setTimeout(resolve, batchDelayMs)).then(() => {
          if (batch === current) batch = null;
          return flush(pending);
        }),
      };
      batch = current;
    }
    for (const tag of new Set(tags)) {
      let adds = batch.tags.get(tag);
      if (!adds) {
        adds = new Map();
        batch.tags.set(tag, adds);
      }
      adds.set(key, expiresAt);
    }
    return batch.done;
  };

  return {
    async add(key, tags, ttl, addOptions = {}) {
      // Tombstones are read through KV's colo cache: exact in the colo that purged, eventually elsewhere.
      if (
        addOptions.fetchedAt !== undefined &&
        (await purgedUntil([...new Set(tags)])) >= addOptions.fetchedAt
      )
        return { stale: true };
      await enqueue(key, tags, ttl);
    },
    async markPurged(tags, until) {
      await Promise.allSettled(
        [...new Set(tags)].map((tag) =>
          kv.put(tombstoneKey(tag), String(until), {
            expiration: Math.ceil(Math.max(until + 3_600_000, now() + 120_000) / 1000),
          }),
        ),
      );
    },
    async keysFor(tags) {
      const t = now();
      const out = new Set<string>();
      const lists = await Promise.all([...new Set(tags)].map((tag) => readList(tag)));
      for (const list of lists) for (const [key, expiresAt] of list) if (expiresAt > t) out.add(key);
      return [...out];
    },
    async remove() {
      // No reverse index: stale keys age out of the tag lists (bounded, TTL-expired).
    },
    async removeTags(tags) {
      await Promise.allSettled([...new Set(tags)].map((tag) => kv.delete(prefix + tag)));
    },
  };
}

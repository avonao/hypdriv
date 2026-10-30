import type { TagIndex } from '../types';

export interface MemoryTagIndexOptions {
  /** Max keys remembered per tag (default 5000; oldest dropped first). */
  maxKeysPerTag?: number;
  /** Max tags (default 20000; least recently written dropped first). */
  maxTags?: number;
  now?: () => number;
}

export interface MemoryTagIndex extends TagIndex {
  readonly size: number;
  clear(): void;
}

/** Per-isolate tag index with a reverse map, exact within the isolate. */
export function createMemoryTagIndex(options: MemoryTagIndexOptions = {}): MemoryTagIndex {
  const maxKeysPerTag = Math.max(1, options.maxKeysPerTag ?? 5000);
  const maxTags = Math.max(1, options.maxTags ?? 20000);
  const now = options.now ?? (() => Date.now());
  const byTag = new Map<string, Map<string, number>>();
  const byKey = new Map<string, Set<string>>();
  /** tag → purged-until (epoch ms). */
  const purged = new Map<string, number>();

  const unlink = (tag: string, key: string) => {
    const keys = byTag.get(tag);
    if (keys) {
      keys.delete(key);
      if (!keys.size) byTag.delete(tag);
    }
    const tags = byKey.get(key);
    if (tags) {
      tags.delete(tag);
      if (!tags.size) byKey.delete(key);
    }
  };

  return {
    get size() {
      return byTag.size;
    },
    clear() {
      byTag.clear();
      byKey.clear();
      purged.clear();
    },
    async add(key, tags, ttl, options = {}) {
      const t = now();
      if (options.fetchedAt !== undefined) {
        for (const tag of tags) {
          const until = purged.get(tag);
          if (until === undefined) continue;
          if (until < t - 3_600_000) purged.delete(tag);
          else if (options.fetchedAt <= until) return { stale: true };
        }
      }
      const expiresAt = t + Math.max(1, ttl) * 1000;
      for (const tag of new Set(tags)) {
        let keys = byTag.get(tag);
        if (!keys) {
          keys = new Map();
        } else {
          byTag.delete(tag); // refresh recency
        }
        byTag.set(tag, keys);
        keys.delete(key);
        keys.set(key, expiresAt);
        while (keys.size > maxKeysPerTag) {
          const oldest = keys.keys().next().value as string;
          unlink(tag, oldest);
        }
        let set = byKey.get(key);
        if (!set) {
          set = new Set();
          byKey.set(key, set);
        }
        set.add(tag);
      }
      while (byTag.size > maxTags) {
        const [tag, keys] = byTag.entries().next().value as [string, Map<string, number>];
        for (const k of [...keys.keys()]) unlink(tag, k);
        byTag.delete(tag);
      }
    },
    async keysFor(tags) {
      const t = now();
      const out = new Set<string>();
      for (const tag of tags) {
        const keys = byTag.get(tag);
        if (!keys) continue;
        for (const [key, expiresAt] of [...keys]) {
          if (expiresAt <= t) unlink(tag, key);
          else out.add(key);
        }
      }
      return [...out];
    },
    async remove(keys) {
      for (const key of keys) {
        const tags = byKey.get(key);
        if (!tags) continue;
        for (const tag of [...tags]) unlink(tag, key);
      }
    },
    async removeTags(tags) {
      for (const tag of tags) {
        const keys = byTag.get(tag);
        if (!keys) continue;
        for (const key of [...keys.keys()]) unlink(tag, key);
      }
    },
    async markPurged(tags, until) {
      for (const tag of tags) purged.set(tag, Math.max(purged.get(tag) ?? 0, until));
      while (purged.size > maxTags) purged.delete(purged.keys().next().value as string);
    },
  };
}

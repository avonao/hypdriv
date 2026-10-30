import type { TagIndex } from '@hypdriv/cache';
import { cyrb53, type DurableObjectNamespaceLike } from '@hypdriv/core';
import type { CounterStore } from '@hypdriv/security';
import { INDEX_SHARDS } from './constants';

/** Calls a Durable Object method over RPC when available, else through the JSON `fetch` transport. */
export async function callDurableObject<T>(
  ns: DurableObjectNamespaceLike,
  name: string,
  op: string,
  args: unknown[],
): Promise<T> {
  const stub = ns.get(ns.idFromName(name)) as unknown as Record<string, (...a: unknown[]) => Promise<T>> & {
    fetch: (input: string, init: RequestInit) => Promise<Response>;
  };
  // Invoke as a method call: workerd RPC stubs are proxies, so `.apply`/`.call` would be sent as RPC names.
  if (typeof stub[op] === 'function') return await stub[op](...args);
  const res = await stub.fetch('https://hypdriv.do/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args }),
  });
  if (!res.ok) throw new Error(`durable object ${op} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Exact, global counters backed by `HypDrivLimiter` (one object per key). */
export function createDoCounterStore(ns: DurableObjectNamespaceLike): CounterStore {
  return {
    async increment(key, windowSeconds, now) {
      return callDurableObject<{ count: number; resetAt: number }>(ns, key, 'increment', [
        key,
        windowSeconds,
        now,
      ]);
    },
    async slidingCount(key, windowSeconds, now) {
      return callDurableObject<{ count: number; resetAt: number }>(ns, key, 'slidingCount', [
        key,
        windowSeconds,
        now,
      ]);
    },
    async takeToken(key, capacity, refillPerSecond, now) {
      return callDurableObject<{ allowed: boolean; remaining: number; resetAt: number }>(
        ns,
        key,
        'takeToken',
        [key, capacity, refillPerSecond, now],
      );
    },
  };
}

function shardFor(tag: string): string {
  return `shard:${cyrb53(tag) % INDEX_SHARDS}`;
}

function groupByShard(tags: string[]): Map<string, string[]> {
  const byShard = new Map<string, string[]>();
  for (const tag of tags) {
    const shard = shardFor(tag);
    const list = byShard.get(shard);
    if (list) list.push(tag);
    else byShard.set(shard, [tag]);
  }
  return byShard;
}

/** Exact tag index backed by `HypDrivIndex`, sharded by tag hash. */
export function createDoTagIndex(ns: DurableObjectNamespaceLike): TagIndex {
  return {
    async add(key, tags, ttl) {
      await Promise.all(
        [...groupByShard(tags)].map(([shard, shardTags]) =>
          callDurableObject(ns, shard, 'add', [key, shardTags, ttl]),
        ),
      );
    },
    async keysFor(tags) {
      const results = await Promise.all(
        [...groupByShard(tags)].map(([shard, shardTags]) =>
          callDurableObject<string[]>(ns, shard, 'keysFor', [shardTags]),
        ),
      );
      return [...new Set(results.flat())];
    },
    async removeTags(tags) {
      await Promise.all(
        [...groupByShard(tags)].map(([shard, shardTags]) =>
          callDurableObject(ns, shard, 'clearTags', [shardTags]),
        ),
      );
    },
    async remove(keys) {
      // Keys may live in any shard; fan out (shards are few and the operation is rare).
      await Promise.all(
        Array.from({ length: INDEX_SHARDS }, (_, i) => callDurableObject(ns, `shard:${i}`, 'remove', [keys])),
      );
    },
  };
}

export interface DoLock {
  acquire(key: string, holder: string, ttlMs: number): Promise<{ acquired: boolean; holder: string | null }>;
  release(key: string, holder: string): Promise<boolean>;
}

/** Cross-isolate locks (request coalescing) backed by `HypDrivLimiter`. */
export function createDoLock(ns: DurableObjectNamespaceLike): DoLock {
  return {
    acquire: (key, holder, ttlMs) => callDurableObject(ns, `lock:${key}`, 'lock', [key, holder, ttlMs]),
    release: (key, holder) => callDurableObject(ns, `lock:${key}`, 'unlock', [key, holder]),
  };
}

import { type CacheLike, HypDrivError, type KVNamespaceLike } from '@hypdriv/core';
import {
  type CounterResult,
  type CounterStore,
  slidingEstimate,
  takeFromBucket,
  type TokenResult,
  windowBounds,
} from './types';

interface WindowEntry {
  count: number;
  resetAt: number;
  /** Kept one extra window so sliding reads can see the previous window. */
  expiresAt: number;
}

interface BucketEntry {
  tokens: number;
  updatedAt: number;
  /** When the bucket is full again and can be dropped. */
  fullAt: number;
}

/**
 * In-memory counters (per isolate / process). Exact within one isolate, approximate across a fleet.
 * Entries expire lazily; a sweep runs every 128 operations or when the map grows past `maxEntries`.
 */
export function createMemoryCounterStore(options: { maxEntries?: number } = {}): CounterStore {
  const maxEntries = options.maxEntries ?? 50_000;
  const windows = new Map<string, WindowEntry>();
  const buckets = new Map<string, BucketEntry>();
  let ops = 0;

  const sweep = (now: number) => {
    for (const [k, e] of windows) if (e.expiresAt <= now) windows.delete(k);
    for (const [k, e] of buckets) if (e.fullAt <= now) buckets.delete(k);
    if (windows.size > maxEntries) {
      // Oldest first (Map preserves insertion order).
      const excess = windows.size - maxEntries;
      let i = 0;
      for (const k of windows.keys()) {
        if (i++ >= excess) break;
        windows.delete(k);
      }
    }
  };
  const tick = (now: number) => {
    if (++ops % 128 === 0 || windows.size + buckets.size > maxEntries) sweep(now);
  };

  const bump = (key: string, windowSeconds: number, now: number): { current: WindowEntry; prev: number } => {
    const { index, start, resetAt } = windowBounds(now, windowSeconds);
    const windowMs = resetAt - start;
    const id = `${key}#${index}`;
    let current = windows.get(id);
    if (!current || current.resetAt <= now) {
      current = { count: 0, resetAt, expiresAt: resetAt + windowMs };
      windows.set(id, current);
    }
    current.count += 1;
    const prev = windows.get(`${key}#${index - 1}`);
    return { current, prev: prev ? prev.count : 0 };
  };

  return {
    name: 'memory',
    async increment(key, windowSeconds, now): Promise<CounterResult> {
      tick(now);
      const { current } = bump(key, windowSeconds, now);
      return { count: current.count, resetAt: current.resetAt };
    },
    async slidingCount(key, windowSeconds, now): Promise<CounterResult> {
      tick(now);
      const { current, prev } = bump(key, windowSeconds, now);
      return { count: slidingEstimate(prev, current.count, now, windowSeconds), resetAt: current.resetAt };
    },
    async takeToken(key, capacity, refillPerSecond, now): Promise<TokenResult> {
      tick(now);
      const existing = buckets.get(key) ?? null;
      const { state, result } = takeFromBucket(existing, capacity, refillPerSecond, now);
      buckets.set(key, {
        ...state,
        fullAt: now + Math.ceil(((capacity - state.tokens) / Math.max(refillPerSecond, 1e-9)) * 1000) + 1000,
      });
      return result;
    },
  };
}

function resolveCache(explicit?: CacheLike): CacheLike {
  if (explicit) return explicit;
  const caches = (globalThis as { caches?: { default?: CacheLike } }).caches;
  if (caches?.default) return caches.default;
  throw new HypDrivError('E_UNSUPPORTED', 'Cache API counter store: `caches.default` is not available in this runtime');
}

/**
 * Approximate counters on the Workers Cache API (zero configuration, per colo). Counters are small
 * `Response`s under `https://hypdriv.ratelimit/<key>/<window>` with `cache-control: max-age`.
 * Increments are read-modify-write without locking, so concurrent requests in the same colo may
 * undercount; the Cache API may also evict entries early. Use the Durable Object limiter or the
 * Rate Limiting binding when exact counting matters.
 */
export function createCacheApiCounterStore(options: { cache?: CacheLike; keyOrigin?: string } = {}): CounterStore {
  const origin = (options.keyOrigin ?? 'https://hypdriv.ratelimit').replace(/\/+$/, '');
  let cache: CacheLike | null = null;
  const getCache = () => {
    if (!cache) cache = resolveCache(options.cache);
    return cache;
  };
  const urlFor = (key: string, suffix: string | number) => `${origin}/${encodeURIComponent(key)}/${suffix}`;

  const readNumber = async (url: string): Promise<number> => {
    const hit = await getCache().match(url);
    if (!hit) return 0;
    const n = Number.parseInt(await hit.text(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const writeText = (url: string, text: string, ttlSeconds: number) =>
    getCache().put(
      url,
      new Response(text, {
        headers: { 'cache-control': `max-age=${Math.max(1, Math.ceil(ttlSeconds))}`, 'content-type': 'text/plain' },
      }),
    );

  const bump = async (key: string, windowSeconds: number, now: number) => {
    const { index, resetAt } = windowBounds(now, windowSeconds);
    const url = urlFor(key, index);
    const count = (await readNumber(url)) + 1;
    // Twice the window: the previous window must survive for sliding reads.
    await writeText(url, String(count), windowSeconds * 2);
    return { count, resetAt, index };
  };

  return {
    name: 'cache-api',
    async increment(key, windowSeconds, now) {
      const { count, resetAt } = await bump(key, windowSeconds, now);
      return { count, resetAt };
    },
    async slidingCount(key, windowSeconds, now) {
      const { count, resetAt, index } = await bump(key, windowSeconds, now);
      const prev = await readNumber(urlFor(key, index - 1));
      return { count: slidingEstimate(prev, count, now, windowSeconds), resetAt };
    },
    async takeToken(key, capacity, refillPerSecond, now) {
      const url = urlFor(key, 'bucket');
      const hit = await getCache().match(url);
      let existing: { tokens: number; updatedAt: number } | null = null;
      if (hit) {
        try {
          const parsed = (await hit.json()) as { tokens?: number; updatedAt?: number };
          if (typeof parsed.tokens === 'number' && typeof parsed.updatedAt === 'number') existing = parsed as never;
        } catch {
          existing = null;
        }
      }
      const { state, result } = takeFromBucket(existing, capacity, refillPerSecond, now);
      await writeText(url, JSON.stringify(state), Math.ceil(capacity / Math.max(refillPerSecond, 1e-9)) + 60);
      return result;
    },
  };
}

/**
 * Counters in Workers KV (global but eventually consistent: writes take up to ~60 s to propagate, so
 * counts are approximate and best suited to coarse limits such as "1000 requests per hour").
 * KV enforces a minimum TTL of 60 seconds.
 */
export function createKvCounterStore(kv: KVNamespaceLike, options: { prefix?: string } = {}): CounterStore {
  const prefix = options.prefix ?? 'hypdriv:rl';
  const keyFor = (key: string, suffix: string | number) => `${prefix}:${key}:${suffix}`;
  const readNumber = async (k: string) => {
    const n = Number.parseInt((await kv.get(k)) ?? '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const bump = async (key: string, windowSeconds: number, now: number) => {
    const { index, resetAt } = windowBounds(now, windowSeconds);
    const k = keyFor(key, index);
    const count = (await readNumber(k)) + 1;
    await kv.put(k, String(count), { expirationTtl: Math.max(60, Math.ceil(windowSeconds * 2)) });
    return { count, resetAt, index };
  };
  return {
    name: 'kv',
    async increment(key, windowSeconds, now) {
      const { count, resetAt } = await bump(key, windowSeconds, now);
      return { count, resetAt };
    },
    async slidingCount(key, windowSeconds, now) {
      const { count, resetAt, index } = await bump(key, windowSeconds, now);
      const prev = await readNumber(keyFor(key, index - 1));
      return { count: slidingEstimate(prev, count, now, windowSeconds), resetAt };
    },
    async takeToken(key, capacity, refillPerSecond, now) {
      const k = keyFor(key, 'bucket');
      let existing: { tokens: number; updatedAt: number } | null = null;
      const raw = await kv.get(k);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { tokens?: number; updatedAt?: number };
          if (typeof parsed.tokens === 'number' && typeof parsed.updatedAt === 'number') existing = parsed as never;
        } catch {
          existing = null;
        }
      }
      const { state, result } = takeFromBucket(existing, capacity, refillPerSecond, now);
      await kv.put(k, JSON.stringify(state), {
        expirationTtl: Math.max(60, Math.ceil(capacity / Math.max(refillPerSecond, 1e-9)) + 60),
      });
      return result;
    },
  };
}

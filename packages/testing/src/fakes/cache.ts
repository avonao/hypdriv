import type { CacheLike } from '@hypdriv/core';
import { createClock, type FakeClock } from '../clock';

interface StoredResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
  storedAt: number;
  /** Absolute expiry in ms, `null` for "no explicit freshness" (kept until deleted). */
  expiresAt: number | null;
}

export interface FakeCache extends CacheLike {
  match(request: RequestInfo | URL, options?: { ignoreMethod?: boolean }): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL, options?: { ignoreMethod?: boolean }): Promise<boolean>;
  readonly clock: FakeClock;
  /** Cache keys (`METHOD url`) currently stored, expired entries included until touched. */
  keys(): string[];
  readonly size: number;
  clear(): void;
  /** Counters for assertions. */
  readonly stats: { hits: number; misses: number; puts: number; rejected: number };
}

function keyFor(
  request: RequestInfo | URL,
  ignoreMethod = false,
): { key: string; method: string; url: string } {
  const req = request instanceof Request ? request : null;
  const rawUrl = req ? req.url : request instanceof URL ? request.href : String(request);
  const url = new URL(rawUrl);
  url.hash = '';
  const method = ignoreMethod ? 'GET' : (req?.method ?? 'GET').toUpperCase();
  return { key: `${method} ${url.href}`, method, url: url.href };
}

function parseDirectives(value: string | null): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k) out[k.toLowerCase()] = v === undefined ? true : v.replace(/^"|"$/g, '');
  }
  return out;
}

/**
 * In-memory Workers `Cache` (what `caches.default` offers): keys are `method + URL`, only `GET` is
 * storable, freshness follows `Cache-Control: s-maxage` → `max-age` → `Expires` on the controllable
 * clock, `no-store`/`private`/`no-cache`/`max-age=0`, `Vary: *` and `Set-Cookie` responses are rejected
 * (never stored), and 206 responses throw like the real API. Matches return `Age` and `CF-Cache-Status: HIT`.
 */
export function createFakeCache(options: { clock?: FakeClock } = {}): FakeCache {
  const clock = options.clock ?? createClock();
  const store = new Map<string, StoredResponse>();
  const stats = { hits: 0, misses: 0, puts: 0, rejected: 0 };

  const fresh = (key: string): StoredResponse | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= clock.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    get clock() {
      return clock;
    },
    get size() {
      return store.size;
    },
    get stats() {
      return stats;
    },
    async match(request, matchOptions = {}) {
      const { key } = keyFor(request, matchOptions.ignoreMethod);
      const entry = fresh(key);
      if (!entry) {
        stats.misses++;
        return undefined;
      }
      stats.hits++;
      const headers = new Headers(entry.headers);
      headers.set('age', String(Math.max(0, Math.floor((clock.now() - entry.storedAt) / 1000))));
      headers.set('cf-cache-status', 'HIT');
      return new Response(entry.body.slice(), {
        status: entry.status,
        statusText: entry.statusText,
        headers,
      });
    },
    async put(request, response) {
      const { key, method } = keyFor(request);
      if (method !== 'GET') throw new TypeError('Cannot cache response to non-GET request.');
      if (response.status === 206)
        throw new TypeError('Cannot cache response to a range request (206 Partial Content).');
      const cc = parseDirectives(response.headers.get('cache-control'));
      const vary = response.headers.get('vary');
      if (
        cc['no-store'] ||
        cc.private ||
        cc['no-cache'] ||
        cc['max-age'] === '0' ||
        (vary && vary.trim() === '*') ||
        response.headers.has('set-cookie')
      ) {
        stats.rejected++;
        await response.arrayBuffer().catch(() => undefined);
        return;
      }
      let ttlSeconds: number | null = null;
      const sMaxAge = Number(cc['s-maxage']);
      const maxAge = Number(cc['max-age']);
      if (typeof cc['s-maxage'] === 'string' && Number.isFinite(sMaxAge)) ttlSeconds = sMaxAge;
      else if (typeof cc['max-age'] === 'string' && Number.isFinite(maxAge)) ttlSeconds = maxAge;
      else {
        const expires = response.headers.get('expires');
        if (expires) {
          const t = Date.parse(expires);
          if (!Number.isNaN(t)) ttlSeconds = Math.max(0, Math.floor((t - clock.now()) / 1000));
        }
      }
      if (ttlSeconds !== null && ttlSeconds <= 0) {
        stats.rejected++;
        await response.arrayBuffer().catch(() => undefined);
        return;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      const headers: Array<[string, string]> = [];
      response.headers.forEach((v, k) => headers.push([k, v]));
      store.set(key, {
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        storedAt: clock.now(),
        expiresAt: ttlSeconds === null ? null : clock.now() + ttlSeconds * 1000,
      });
      stats.puts++;
    },
    async delete(request, deleteOptions = {}) {
      const { key } = keyFor(request, deleteOptions.ignoreMethod);
      return store.delete(key);
    },
    keys: () => [...store.keys()],
    clear() {
      store.clear();
    },
  };
}

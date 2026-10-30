import { type CacheLike, type CacheStorageLike, HypDrivError } from '@hypdriv/core';
import { CACHE_KEY_ORIGIN, cacheKeyUrl } from '../keys';
import type { CacheStore } from '../types';
import {
  cacheTagHeader,
  decodeMeta,
  encodeMeta,
  isNullBodyStatus,
  lifetimeOf,
  META_HEADER,
  ORIGIN_CACHE_CONTROL_HEADER,
  ORIGIN_EXPIRES_HEADER,
  storableHeaders,
} from './meta';

export interface CacheApiStoreOptions {
  /** A `Cache` instance (defaults to `caches.default`, or `caches.open(cacheName)`). */
  cache?: CacheLike | Promise<CacheLike>;
  /** Named cache opened with `caches.open()` instead of `caches.default`. */
  cacheName?: string;
  /** Origin of the synthetic request URLs (default `https://hypdriv.cache`). */
  keyOrigin?: string;
}

/**
 * Workers Cache API store (`caches.default`, per colo, zero configuration). Metadata travels in the
 * `x-hypdriv-meta` header; the stored copy carries `cache-control: public, s-maxage=<lifetime>` so
 * workerd keeps it for the whole fresh + stale window, and the origin's caching headers are restored
 * on read. The entry's tags are stored as `Cache-Tag`, so zone purges by tag reach every colo.
 * `set-cookie` is never stored.
 */
export function createCacheApiStore(options: CacheApiStoreOptions = {}): CacheStore {
  const keyOrigin = options.keyOrigin ?? CACHE_KEY_ORIGIN;
  let resolved: Promise<CacheLike> | null = null;
  const cache = () => {
    resolved ??= resolveCache(options);
    return resolved;
  };

  return {
    name: options.cacheName ? `cache-api:${options.cacheName}` : 'cache-api',
    async get(key) {
      const c = await cache();
      const hit = await c.match(cacheKeyUrl(key, keyOrigin));
      if (!hit) return null;
      const meta = decodeMeta(hit.headers.get(META_HEADER));
      if (!meta) {
        void hit.body?.cancel().catch(() => undefined);
        return null;
      }
      const headers = new Headers(hit.headers);
      headers.delete(META_HEADER);
      headers.delete('cache-control');
      headers.delete('expires');
      // Index for zone purge-by-tag only; the stage emits the client-facing tags itself.
      headers.delete('cache-tag');
      const originCc = headers.get(ORIGIN_CACHE_CONTROL_HEADER);
      const originExpires = headers.get(ORIGIN_EXPIRES_HEADER);
      headers.delete(ORIGIN_CACHE_CONTROL_HEADER);
      headers.delete(ORIGIN_EXPIRES_HEADER);
      if (originCc) headers.set('cache-control', originCc);
      if (originExpires) headers.set('expires', originExpires);
      headers.delete('age');
      return {
        response: new Response(isNullBodyStatus(hit.status) ? null : hit.body, {
          status: hit.status,
          statusText: hit.statusText,
          headers,
        }),
        meta,
      };
    },
    async set(key, entry) {
      const lifetime = Math.ceil(lifetimeOf(entry.meta));
      if (lifetime <= 0) {
        void entry.response.body?.cancel().catch(() => undefined);
        return;
      }
      const headers = storableHeaders(entry.response.headers);
      const originCc = headers.get('cache-control');
      const originExpires = headers.get('expires');
      if (originCc) headers.set(ORIGIN_CACHE_CONTROL_HEADER, originCc);
      if (originExpires) headers.set(ORIGIN_EXPIRES_HEADER, originExpires);
      headers.delete('expires');
      headers.delete('pragma');
      if (headers.get('vary')?.trim() === '*') headers.delete('vary');
      headers.set('cache-control', `public, s-maxage=${lifetime}`);
      // Cloudflare indexes `Cache-Tag` on `cache.put()`: a zone purge by tag (the purger configured with
      // CACHE_PURGE_ZONE_ID / CACHE_PURGE_API_TOKEN) then drops this copy in every data centre, not only
      // in the one where the purge ran.
      const tags = cacheTagHeader(entry.meta.tags);
      if (tags) headers.set('cache-tag', tags);
      headers.set(META_HEADER, encodeMeta({ ...entry.meta, key }));
      const status = entry.response.status;
      const stored = new Response(isNullBodyStatus(status) ? null : entry.response.body, {
        status,
        statusText: entry.response.statusText,
        headers,
      });
      const c = await cache();
      await c.put(cacheKeyUrl(key, keyOrigin), stored);
    },
    async delete(key) {
      const c = await cache();
      await c.delete(cacheKeyUrl(key, keyOrigin));
    },
  };
}

async function resolveCache(options: CacheApiStoreOptions): Promise<CacheLike> {
  if (options.cache) return options.cache;
  const storage = (globalThis as { caches?: CacheStorageLike }).caches;
  if (!storage) throw new HypDrivError('E_UNSUPPORTED', 'The Cache API is not available in this runtime');
  if (options.cacheName && typeof storage.open === 'function') return storage.open(options.cacheName);
  if (storage.default) return storage.default;
  if (typeof storage.open === 'function') return storage.open('hypdriv');
  throw new HypDrivError('E_UNSUPPORTED', 'The Cache API exposes neither `default` nor `open()`');
}

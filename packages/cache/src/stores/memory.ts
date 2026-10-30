import type { CacheMeta, CacheStore } from '../types';
import { headersSize, isNullBodyStatus, lifetimeOf, readBody, storableHeaders } from './meta';

export interface MemoryStoreOptions {
  /** Max entries (default 1000). */
  maxEntries?: number;
  /** Approximate max bytes of bodies plus headers (default 64 MB). */
  maxBytes?: number;
  /** Clock in epoch ms (tests). */
  now?: () => number;
}

export interface MemoryCacheStore extends CacheStore {
  readonly size: number;
  readonly bytes: number;
  clear(): void;
}

interface Slot {
  meta: CacheMeta;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
  bytes: number;
  expiresAt: number;
}

/**
 * Per-isolate LRU store (Node/dev baseline and the first tier of the tiered store). Bodies are
 * buffered into `ArrayBuffer`s; `set()` consumes the response body.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryCacheStore {
  const maxEntries = Math.max(1, options.maxEntries ?? 1000);
  const maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024 * 1024);
  const now = options.now ?? (() => Date.now());
  const slots = new Map<string, Slot>();
  let bytes = 0;

  const remove = (key: string) => {
    const slot = slots.get(key);
    if (!slot) return;
    slots.delete(key);
    bytes -= slot.bytes;
  };

  const evict = () => {
    for (const [key, slot] of slots) {
      if (slots.size <= maxEntries && bytes <= maxBytes) break;
      slots.delete(key);
      bytes -= slot.bytes;
    }
  };

  return {
    name: 'memory',
    get size() {
      return slots.size;
    },
    get bytes() {
      return bytes;
    },
    clear() {
      slots.clear();
      bytes = 0;
    },
    async get(key) {
      const slot = slots.get(key);
      if (!slot) return null;
      if (slot.expiresAt <= now()) {
        remove(key);
        return null;
      }
      // Refresh recency.
      slots.delete(key);
      slots.set(key, slot);
      const body = slot.body && !isNullBodyStatus(slot.status) ? slot.body : null;
      return {
        response: new Response(body, {
          status: slot.status,
          statusText: slot.statusText,
          headers: new Headers(slot.headers),
        }),
        meta: { ...slot.meta, tags: [...slot.meta.tags], vary: [...slot.meta.vary] },
      };
    },
    async set(key, entry) {
      const lifetime = lifetimeOf(entry.meta);
      const body = await readBody(entry.response.body, maxBytes);
      if (body === null || lifetime <= 0) return;
      const headers = storableHeaders(entry.response.headers);
      const slot: Slot = {
        meta: { ...entry.meta, key },
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers: [...headers.entries()],
        body: body.byteLength ? body : null,
        bytes: body.byteLength + headersSize(headers) + 256,
        expiresAt: entry.meta.storedAt + lifetime * 1000,
      };
      remove(key);
      slots.set(key, slot);
      bytes += slot.bytes;
      evict();
    },
    async delete(key) {
      remove(key);
    },
  };
}

import type { CacheMeta } from '../types';

/** Response header carrying the JSON metadata inside Cache API entries. */
export const META_HEADER = 'x-hypdriv-meta';
/** Headers that hold the origin's caching headers while a Cache API entry carries the store's own. */
export const ORIGIN_CACHE_CONTROL_HEADER = 'x-hypdriv-origin-cache-control';
export const ORIGIN_EXPIRES_HEADER = 'x-hypdriv-origin-expires';

/** Cloudflare `Cache-Tag` limits: 1,024 bytes per tag, 16 KB for the header. */
const MAX_CACHE_TAG_BYTES = 1024;
const MAX_CACHE_TAG_HEADER_BYTES = 16 * 1024;

/**
 * A `Cache-Tag` header value for the given tags (Cloudflare's purge-by-tag index): printable ASCII
 * without commas or whitespace, de-duplicated, each tag ≤ 1,024 bytes, the whole header ≤ 16 KB.
 * `null` when no tag survives.
 */
export function cacheTagHeader(tags: Iterable<string>): string | null {
  const out: string[] = [];
  const seen = new Set<string>();
  let size = 0;
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/[^\x21-\x7e]|,/g, '');
    if (!tag || tag.length > MAX_CACHE_TAG_BYTES || seen.has(tag.toLowerCase())) continue;
    if (size + tag.length + (out.length ? 1 : 0) > MAX_CACHE_TAG_HEADER_BYTES) break;
    seen.add(tag.toLowerCase());
    size += tag.length + (out.length ? 1 : 0);
    out.push(tag);
  }
  return out.length ? out.join(',') : null;
}

/** Response headers that must never be persisted (per-response values re-added on every hit). */
const VOLATILE_HEADERS = new Set([
  'set-cookie',
  'age',
  'server-timing',
  'x-hypdriv-cache',
  'x-hypdriv-cache-key',
  'cache-tag',
  'surrogate-key',
  'x-request-id',
  'x-hypdriv-request-id',
  'connection',
  'keep-alive',
  'transfer-encoding',
  META_HEADER,
  ORIGIN_CACHE_CONTROL_HEADER,
  ORIGIN_EXPIRES_HEADER,
]);

/** Statuses whose responses carry no body by definition. */
export function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

/** Copies headers for storage, dropping volatile and hop-by-hop ones. */
export function storableHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!VOLATILE_HEADERS.has(name.toLowerCase())) out.append(name, value);
  });
  return out;
}

/** Total lifetime of an entry in seconds (fresh + stale-while-revalidate + stale-if-error). */
export function lifetimeOf(meta: Pick<CacheMeta, 'ttl' | 'swr' | 'staleIfError'>): number {
  return Math.max(0, meta.ttl) + Math.max(0, meta.swr) + Math.max(0, meta.staleIfError);
}

export type Freshness = 'fresh' | 'stale' | 'error' | 'expired';

/** Classifies an entry at `now` (epoch ms): usable, usable while revalidating, usable only on upstream errors, or dead. */
export function entryFreshness(meta: CacheMeta, now: number): { state: Freshness; age: number } {
  const age = Math.max(0, (now - meta.storedAt) / 1000);
  if (age < meta.ttl) return { state: 'fresh', age };
  if (age < meta.ttl + meta.swr) return { state: 'stale', age };
  if (age < lifetimeOf(meta)) return { state: 'error', age };
  return { state: 'expired', age };
}

export function encodeMeta(meta: CacheMeta): string {
  return JSON.stringify(meta);
}

/** Parses stored metadata, returning null for foreign or corrupt entries. */
export function decodeMeta(value: string | null | undefined): CacheMeta | null {
  if (!value) return null;
  try {
    return normalizeMeta(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Validates an untrusted metadata object (from a store) into a `CacheMeta`, or null. */
export function normalizeMeta(value: unknown): CacheMeta | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<CacheMeta>;
  if (
    typeof parsed.key !== 'string' ||
    typeof parsed.storedAt !== 'number' ||
    typeof parsed.ttl !== 'number' ||
    typeof parsed.status !== 'number'
  )
    return null;
  return {
    key: parsed.key,
    storedAt: parsed.storedAt,
    ttl: parsed.ttl,
    swr: typeof parsed.swr === 'number' ? parsed.swr : 0,
    staleIfError: typeof parsed.staleIfError === 'number' ? parsed.staleIfError : 0,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
    buildId: typeof parsed.buildId === 'string' ? parsed.buildId : '',
    policyId: typeof parsed.policyId === 'string' ? parsed.policyId : '',
    vary: Array.isArray(parsed.vary) ? parsed.vary.filter((v): v is string => typeof v === 'string') : [],
    status: parsed.status,
  };
}

/** Reads a stream fully; returns null (and cancels the stream) when it exceeds `maxBytes`. */
export async function readBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Approximate memory footprint of a header set. */
export function headersSize(headers: Headers): number {
  let size = 0;
  headers.forEach((v, k) => {
    size += k.length + v.length + 4;
  });
  return size;
}

import type { KVNamespaceLike } from '@hypdriv/core';
import type { CacheEntry, CacheMeta, CacheStore } from '../types';
import { isNullBodyStatus, lifetimeOf, normalizeMeta, readBody, storableHeaders } from './meta';

export interface KvStoreOptions {
  /** Key prefix (default `hypdriv:cache:`). */
  prefix?: string;
  /** Max body size stored in KV (default 24 MB; KV values are capped at 25 MiB). */
  maxBytes?: number;
  /** Clock in epoch ms (tests). */
  now?: () => number;
}

/** KV metadata is capped at 1024 bytes, so it only carries a summary; headers live in the value frame. */
interface KvSummary {
  v: 1;
  storedAt: number;
  expiresAt: number;
  status: number;
  policyId: string;
}

interface Envelope {
  meta: CacheMeta;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

const MAGIC = new Uint8Array([0x48, 0x59, 0x50, 0x43]); // "HYPC"
const FRAME_HEADER = 8;
const KV_MIN_TTL = 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serialises an entry into the framed KV value: `HYPC` + u32 envelope length + JSON envelope + body. */
export function encodeKvValue(envelope: Envelope, body: ArrayBuffer | null): ArrayBuffer {
  const json = encoder.encode(JSON.stringify(envelope));
  const bodyBytes = body ? new Uint8Array(body) : new Uint8Array(0);
  const out = new Uint8Array(FRAME_HEADER + json.byteLength + bodyBytes.byteLength);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, json.byteLength, false);
  out.set(json, FRAME_HEADER);
  out.set(bodyBytes, FRAME_HEADER + json.byteLength);
  return out.buffer;
}

/** Parses a framed KV value; returns null for foreign or corrupt values. */
export function decodeKvValue(value: ArrayBuffer): { envelope: Envelope; body: ArrayBuffer } | null {
  if (value.byteLength < FRAME_HEADER) return null;
  const bytes = new Uint8Array(value);
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null;
  const length = new DataView(value).getUint32(4, false);
  if (FRAME_HEADER + length > value.byteLength) return null;
  try {
    const raw = JSON.parse(
      decoder.decode(bytes.subarray(FRAME_HEADER, FRAME_HEADER + length)),
    ) as Partial<Envelope>;
    const meta = normalizeMeta(raw.meta);
    if (!meta || typeof raw.status !== 'number' || !Array.isArray(raw.headers)) return null;
    return {
      envelope: {
        meta,
        status: raw.status,
        statusText: typeof raw.statusText === 'string' ? raw.statusText : '',
        headers: raw.headers.filter(
          (h): h is [string, string] =>
            Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string',
        ),
      },
      body: value.slice(FRAME_HEADER + length),
    };
  } catch {
    return null;
  }
}

/**
 * Global KV store (optional upgrade, eventually consistent). Values are framed (envelope + body) because
 * KV metadata is limited to 1 KB; `expirationTtl` is the entry lifetime with KV's 60 s minimum, so the
 * freshness check on read decides for short lifetimes.
 */
export function createKvStore(kv: KVNamespaceLike, options: KvStoreOptions = {}): CacheStore {
  const prefix = options.prefix ?? 'hypdriv:cache:';
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  const now = options.now ?? (() => Date.now());
  return {
    name: 'kv',
    async get(key): Promise<CacheEntry | null> {
      const value = await kv.get(prefix + key, 'arrayBuffer');
      if (!value) return null;
      const decoded = decodeKvValue(value);
      if (!decoded) return null;
      const { envelope, body } = decoded;
      if (envelope.meta.storedAt + lifetimeOf(envelope.meta) * 1000 <= now()) return null;
      return {
        response: new Response(isNullBodyStatus(envelope.status) || !body.byteLength ? null : body, {
          status: envelope.status,
          statusText: envelope.statusText,
          headers: new Headers(envelope.headers),
        }),
        meta: envelope.meta,
      };
    },
    async set(key, entry) {
      const lifetime = Math.ceil(lifetimeOf(entry.meta));
      const body = await readBody(entry.response.body, maxBytes);
      if (body === null || lifetime <= 0) return;
      const meta: CacheMeta = { ...entry.meta, key };
      const envelope: Envelope = {
        meta,
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers: [...storableHeaders(entry.response.headers).entries()],
      };
      const summary: KvSummary = {
        v: 1,
        storedAt: meta.storedAt,
        expiresAt: meta.storedAt + lifetime * 1000,
        status: envelope.status,
        policyId: meta.policyId.slice(0, 200),
      };
      await kv.put(prefix + key, encodeKvValue(envelope, body), {
        expirationTtl: Math.max(KV_MIN_TTL, lifetime),
        metadata: summary,
      });
    },
    async delete(key) {
      await kv.delete(prefix + key);
    },
  };
}

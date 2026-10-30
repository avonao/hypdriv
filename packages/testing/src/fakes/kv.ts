import { base64UrlDecode, base64UrlEncode, type KVNamespaceLike, utf8Decode } from '@hypdriv/core';
import { createClock, type FakeClock } from '../clock';

export type FakeKVValueType = 'text' | 'json' | 'arrayBuffer' | 'stream';

export interface FakeKVEntry {
  value: Uint8Array;
  /** Absolute expiry, epoch seconds. */
  expiration?: number;
  metadata?: unknown;
}

export interface FakeKVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface FakeKVListResult {
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  list_complete: boolean;
  cursor?: string;
}

export interface FakeKVPutOptions {
  /** Absolute expiry, epoch seconds. */
  expiration?: number;
  /** Relative expiry in seconds (real KV requires ≥ 60; the fake accepts any positive value). */
  expirationTtl?: number;
  metadata?: unknown;
}

export interface FakeKV extends KVNamespaceLike {
  get(key: string, options?: { type?: 'text'; cacheTtl?: number } | 'text'): Promise<string | null>;
  get(key: string, options: { type: 'json'; cacheTtl?: number } | 'json'): Promise<unknown>;
  get(
    key: string,
    options: { type: 'arrayBuffer'; cacheTtl?: number } | 'arrayBuffer',
  ): Promise<ArrayBuffer | null>;
  get(
    key: string,
    options: { type: 'stream'; cacheTtl?: number } | 'stream',
  ): Promise<ReadableStream<Uint8Array> | null>;
  getWithMetadata<M = unknown>(
    key: string,
    options?: FakeKVValueType | { type?: FakeKVValueType; cacheTtl?: number },
  ): Promise<{ value: unknown; metadata: M | null }>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: FakeKVPutOptions,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: FakeKVListOptions): Promise<FakeKVListResult>;
  /** The clock expirations are evaluated against. */
  readonly clock: FakeClock;
  /** Live (non-expired) key count. */
  readonly size: number;
  /** Snapshot of live entries as text (for assertions). */
  dump(): Record<string, string>;
  /** Raw entry, including expired ones not yet purged. */
  entry(key: string): FakeKVEntry | undefined;
  clear(): void;
  /** Number of `get` calls so far (useful to assert memoisation). */
  readonly reads: number;
  /** Number of `put` calls so far. */
  readonly writes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function toBytes(value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<Uint8Array> {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  const buffer = await new Response(value as ReadableStream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * In-memory `KVNamespace` with the full read/write/list surface, `expiration`/`expirationTtl` evaluated
 * against a controllable clock, metadata, and counters for `get`/`put` calls.
 */
export function createFakeKV(options: { clock?: FakeClock; initial?: Record<string, string> } = {}): FakeKV {
  const clock = options.clock ?? createClock();
  const store = new Map<string, FakeKVEntry>();
  let reads = 0;
  let writes = 0;

  const live = (key: string): FakeKVEntry | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiration !== undefined && entry.expiration <= clock.nowSeconds()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const typeOf = (options: unknown): FakeKVValueType => {
    if (typeof options === 'string') return options as FakeKVValueType;
    if (options && typeof options === 'object' && typeof (options as { type?: string }).type === 'string')
      return (options as { type: FakeKVValueType }).type;
    return 'text';
  };

  const decode = (entry: FakeKVEntry, type: FakeKVValueType): unknown => {
    switch (type) {
      case 'json':
        return JSON.parse(decoder.decode(entry.value));
      case 'arrayBuffer':
        return entry.value.buffer.slice(
          entry.value.byteOffset,
          entry.value.byteOffset + entry.value.byteLength,
        );
      case 'stream':
        return new Response(entry.value.slice()).body;
      default:
        return decoder.decode(entry.value);
    }
  };

  for (const [key, value] of Object.entries(options.initial ?? {}))
    store.set(key, { value: encoder.encode(value) });

  const kv = {
    get clock() {
      return clock;
    },
    get size() {
      let n = 0;
      for (const key of [...store.keys()]) if (live(key)) n++;
      return n;
    },
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    async get(key: string, getOptions?: unknown): Promise<unknown> {
      reads++;
      const entry = live(key);
      if (!entry) return null;
      return decode(entry, typeOf(getOptions));
    },
    async getWithMetadata(key: string, getOptions?: unknown) {
      reads++;
      const entry = live(key);
      if (!entry) return { value: null, metadata: null };
      return { value: decode(entry, typeOf(getOptions)), metadata: (entry.metadata ?? null) as never };
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      putOptions: FakeKVPutOptions = {},
    ) {
      writes++;
      const entry: FakeKVEntry = { value: await toBytes(value) };
      if (putOptions.expiration !== undefined) entry.expiration = Math.floor(putOptions.expiration);
      else if (putOptions.expirationTtl !== undefined) {
        if (putOptions.expirationTtl <= 0) throw new TypeError('expirationTtl must be positive');
        entry.expiration = clock.nowSeconds() + Math.floor(putOptions.expirationTtl);
      }
      if (putOptions.metadata !== undefined) entry.metadata = putOptions.metadata;
      store.set(key, entry);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(listOptions: FakeKVListOptions = {}): Promise<FakeKVListResult> {
      const limit = Math.max(1, Math.min(listOptions.limit ?? 1000, 1000));
      const keys = [...store.keys()]
        .filter((key) => live(key) && (!listOptions.prefix || key.startsWith(listOptions.prefix)))
        .sort();
      const start = listOptions.cursor ? keys.findIndex((k) => k > decodeCursor(listOptions.cursor!)) : 0;
      const from = start < 0 ? keys.length : start;
      const page = keys.slice(from, from + limit);
      const complete = from + limit >= keys.length;
      return {
        keys: page.map((name) => {
          const entry = store.get(name)!;
          return {
            name,
            ...(entry.expiration !== undefined ? { expiration: entry.expiration } : {}),
            ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
          };
        }),
        list_complete: complete,
        ...(complete ? {} : { cursor: encodeCursor(page[page.length - 1]!) }),
      };
    },
    dump() {
      const out: Record<string, string> = {};
      for (const key of [...store.keys()].sort()) {
        const entry = live(key);
        if (entry) out[key] = decoder.decode(entry.value);
      }
      return out;
    },
    entry: (key: string) => store.get(key),
    clear() {
      store.clear();
    },
  };
  return kv as unknown as FakeKV;
}

function encodeCursor(key: string): string {
  return base64UrlEncode(key);
}

function decodeCursor(cursor: string): string {
  try {
    return utf8Decode(base64UrlDecode(cursor));
  } catch {
    return cursor;
  }
}

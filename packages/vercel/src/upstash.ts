import {
  base64Decode,
  base64Encode,
  digest,
  HypDrivError,
  hexEncode,
  type KVNamespaceLike,
  utf8Decode,
  utf8Encode,
} from '@hypdriv/core';
import { type CounterStore, slidingEstimate, type TokenResult, windowBounds } from '@hypdriv/security';
import { fetchWithTimeout } from './util';

/** Connection options shared by `upstashKv` and `upstashCounterStore`. */
export interface UpstashOptions {
  /** REST URL (`KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`). */
  url: string;
  /** REST token (`KV_REST_API_TOKEN` / `UPSTASH_REDIS_REST_TOKEN`). Sent as `Authorization: Bearer`, never logged. */
  token: string;
  /** Key prefix for everything Hypdriv writes (default `hypdriv:`, config `vercel.redis.prefix`). */
  prefix?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
}

/** A Redis command as sent to Upstash: `['SET', 'key', 'value', 'EX', 60]`. */
export type RedisCommand = Array<string | number>;

/** Minimal Upstash REST client: one command per `POST /`, batches through `POST /pipeline`. */
export interface UpstashClient {
  /** Runs one command and returns its `result`. */
  command(command: RedisCommand): Promise<unknown>;
  /** Runs commands in order in one round trip; throws when any of them failed. */
  pipeline(commands: RedisCommand[]): Promise<unknown[]>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Creates the REST client. Throws a `TypeError` when the URL or token is missing or malformed. */
export function createUpstashClient(options: UpstashOptions): UpstashClient {
  const base = (options.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+/.test(base)) throw new TypeError('Upstash: `url` must be an http(s) REST URL');
  if (!options.token?.trim()) throw new TypeError('Upstash: `token` is required');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = { authorization: `Bearer ${options.token.trim()}`, 'content-type': 'application/json' };

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await fetchWithTimeout(
      doFetch,
      `${base}${path}`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      timeoutMs,
      'upstash',
    );
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new HypDrivError('E_UPSTREAM', `upstash: invalid JSON response (HTTP ${res.status})`, {
        status: res.status,
      });
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : '';
      throw new HypDrivError('E_UPSTREAM', `upstash: HTTP ${res.status}${message ? `: ${message}` : ''}`, {
        status: res.status,
      });
    }
    return parsed;
  };

  return {
    async command(command) {
      const body = (await post('', command)) as { result?: unknown; error?: unknown } | null;
      if (body && typeof body === 'object' && body.error !== undefined && body.error !== null)
        throw new HypDrivError('E_UPSTREAM', `upstash: ${String(body.error)}`, {
          command: String(command[0]),
        });
      return body?.result ?? null;
    },
    async pipeline(commands) {
      if (!commands.length) return [];
      const body = await post('/pipeline', commands);
      if (!Array.isArray(body) || body.length !== commands.length)
        throw new HypDrivError('E_UPSTREAM', 'upstash: unexpected pipeline response');
      return body.map((item: { result?: unknown; error?: unknown }, i) => {
        if (item?.error !== undefined && item.error !== null)
          throw new HypDrivError(
            'E_UPSTREAM',
            `upstash: command ${i + 1} (${commands[i]![0]}) failed: ${String(item.error)}`,
            {
              command: String(commands[i]![0]),
            },
          );
        return item?.result ?? null;
      });
    },
  };
}

// -- KV ------------------------------------------------------------------------------------------------

/** Values written as binary are stored as base64 behind this marker. */
const BINARY_MARKER = '~hypdriv:b64~';
/** Text values that happen to start with the reserved prefix are escaped with this marker. */
const TEXT_MARKER = '~hypdriv:txt~';
const RESERVED = '~hypdriv:';

type KvValueType = 'text' | 'json' | 'arrayBuffer';

function valueType(options: unknown): KvValueType {
  if (typeof options === 'string') return options as KvValueType;
  if (options && typeof options === 'object' && typeof (options as { type?: unknown }).type === 'string')
    return (options as { type: KvValueType }).type;
  return 'text';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Decodes a stored string into text or bytes. */
function decodeStored(stored: string): { text: string } | { bytes: Uint8Array } {
  if (stored.startsWith(BINARY_MARKER)) return { bytes: base64Decode(stored.slice(BINARY_MARKER.length)) };
  if (stored.startsWith(TEXT_MARKER)) return { text: stored.slice(TEXT_MARKER.length) };
  return { text: stored };
}

async function encodeValue(value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<string> {
  if (typeof value === 'string') return value.startsWith(RESERVED) ? TEXT_MARKER + value : value;
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value))
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (value && typeof (value as ReadableStream).getReader === 'function')
    bytes = new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  else throw new TypeError('upstashKv.put: unsupported value type');
  return BINARY_MARKER + base64Encode(bytes);
}

/** Escapes Redis glob metacharacters so a literal prefix can be used in `SCAN MATCH`. */
export function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, '\\$&');
}

/** Workers-KV-compatible namespace over Upstash Redis. */
export type UpstashKv = KVNamespaceLike & {
  readonly name: 'upstash';
  /** The underlying REST client (for commands the KV interface does not cover). */
  readonly client: UpstashClient;
  /** The key prefix applied to every key. */
  readonly prefix: string;
};

/**
 * A `KVNamespaceLike` over Upstash's REST API (Vercel Marketplace Redis), usable wherever Hypdriv takes a
 * KV binding (cache store, tag index, flags, redirects, idempotency). Strongly consistent, unlike Workers
 * KV. Text is stored as-is; binary values are stored base64-encoded behind a type marker. `expirationTtl`
 * maps to `EX` (it wins over `expiration`, which maps to `EXAT`). Redis has no per-key metadata, so
 * `metadata` is not persisted and `list()` never returns it. `list()` uses `SCAN … MATCH prefix* COUNT`,
 * which may return slightly more than `limit` keys per page.
 */
export function upstashKv(options: UpstashOptions): UpstashKv {
  const client = createUpstashClient(options);
  const prefix = options.prefix ?? 'hypdriv:';
  const k = (key: string) => prefix + key;

  async function get(key: string, options?: unknown): Promise<unknown> {
    const stored = await client.command(['GET', k(key)]);
    if (stored === null || stored === undefined) return null;
    const decoded = decodeStored(String(stored));
    const type = valueType(options);
    if (type === 'arrayBuffer')
      return toArrayBuffer('bytes' in decoded ? decoded.bytes : utf8Encode(decoded.text));
    const text = 'bytes' in decoded ? utf8Decode(decoded.bytes) : decoded.text;
    return type === 'json' ? JSON.parse(text) : text;
  }

  return {
    name: 'upstash',
    client,
    prefix,
    get: get as KVNamespaceLike['get'],
    async put(key, value, putOptions) {
      const command: RedisCommand = ['SET', k(key), await encodeValue(value)];
      if (putOptions?.expirationTtl !== undefined)
        command.push('EX', Math.max(1, Math.ceil(putOptions.expirationTtl)));
      else if (putOptions?.expiration !== undefined)
        command.push('EXAT', Math.max(1, Math.floor(putOptions.expiration)));
      await client.command(command);
    },
    async delete(key) {
      await client.command(['DEL', k(key)]);
    },
    async list(listOptions = {}) {
      const limit = Math.max(1, Math.min(1000, listOptions.limit ?? 1000));
      const match = `${escapeGlob(prefix + (listOptions.prefix ?? ''))}*`;
      let cursor = listOptions.cursor ?? '0';
      const names: string[] = [];
      const seen = new Set<string>();
      do {
        const result = (await client.command(['SCAN', cursor, 'MATCH', match, 'COUNT', limit])) as [
          string | number,
          string[],
        ];
        cursor = String(result?.[0] ?? '0');
        for (const full of result?.[1] ?? []) {
          if (!full.startsWith(prefix) || seen.has(full)) continue;
          seen.add(full);
          names.push(full.slice(prefix.length));
        }
      } while (cursor !== '0' && names.length < limit);
      const complete = cursor === '0';
      return {
        keys: names.map((name) => ({ name })),
        list_complete: complete,
        ...(complete ? {} : { cursor }),
      };
    },
  };
}

// -- Counters ------------------------------------------------------------------------------------------

/**
 * Token bucket step in Lua (same arithmetic as `takeFromBucket` in `@hypdriv/security`), executed atomically
 * by Redis. Numbers travel as strings so fractional token counts survive Redis' integer reply conversion.
 */
export const TOKEN_BUCKET_SCRIPT = `local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = capacity
else
  local elapsed = now - updated
  if elapsed < 0 then elapsed = 0 end
  tokens = math.min(capacity, tokens + (elapsed / 1000) * refill)
end
if tokens ~= tokens or tokens < 0 then tokens = capacity end
local allowed = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'updatedAt', tostring(now))
redis.call('PEXPIRE', key, ttl)
return { allowed, tostring(tokens) }`;

const MAX_TTL_MS = 365 * 24 * 3600 * 1000;

let scriptSha: Promise<string> | null = null;
function tokenBucketSha(): Promise<string> {
  scriptSha ??= digest(TOKEN_BUCKET_SCRIPT, 'SHA-1').then(hexEncode);
  return scriptSha;
}

/**
 * Exact, global rate-limit counters in Upstash Redis. Fixed and sliding windows use one pipeline
 * (`INCR` + `PEXPIRE … NX`, plus `GET` of the previous window for sliding); keys are
 * `<prefix>rl:<key>:<windowStart>` and live two windows. Token buckets run a Lua script (`EVALSHA`, falling
 * back to `EVAL` when Redis has not cached it yet) under `<prefix>rl:<key>:bucket`.
 */
export function upstashCounterStore(options: UpstashOptions): CounterStore & { readonly name: 'upstash' } {
  const client = createUpstashClient(options);
  const prefix = options.prefix ?? 'hypdriv:';
  const windowKey = (key: string, start: number) => `${prefix}rl:${key}:${start}`;

  const bump = async (key: string, windowSeconds: number, now: number, withPrevious: boolean) => {
    const { start, resetAt } = windowBounds(now, windowSeconds);
    const windowMs = resetAt - start;
    const current = windowKey(key, start);
    const commands: RedisCommand[] = [
      ['INCR', current],
      ['PEXPIRE', current, Math.min(MAX_TTL_MS, windowMs * 2), 'NX'],
    ];
    if (withPrevious) commands.push(['GET', windowKey(key, start - windowMs)]);
    const results = await client.pipeline(commands);
    const count = Number(results[0]);
    const previous = withPrevious ? Number(results[2] ?? 0) : 0;
    return {
      count: Number.isFinite(count) ? count : 0,
      previous: Number.isFinite(previous) ? previous : 0,
      resetAt,
    };
  };

  const evalBucket = async (args: Array<string | number>): Promise<unknown> => {
    const sha = await tokenBucketSha();
    try {
      return await client.command(['EVALSHA', sha, 1, ...args]);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      return client.command(['EVAL', TOKEN_BUCKET_SCRIPT, 1, ...args]);
    }
  };

  return {
    name: 'upstash',
    async increment(key, windowSeconds, now) {
      const { count, resetAt } = await bump(key, windowSeconds, now, false);
      return { count, resetAt };
    },
    async slidingCount(key, windowSeconds, now) {
      const { count, previous, resetAt } = await bump(key, windowSeconds, now, true);
      return { count: slidingEstimate(previous, count, now, windowSeconds), resetAt };
    },
    async takeToken(key, capacity, refillPerSecond, now): Promise<TokenResult> {
      const cap = Math.max(1, capacity);
      const refill = Math.max(refillPerSecond, 1e-9);
      const ttl = Math.min(MAX_TTL_MS, (Math.ceil(cap / refill) + 60) * 1000);
      const reply = (await evalBucket([`${prefix}rl:${key}:bucket`, cap, refill, now, ttl])) as [
        number | string,
        number | string,
      ];
      const allowed = Number(reply?.[0]) === 1;
      let tokens = Number(reply?.[1]);
      if (!Number.isFinite(tokens) || tokens < 0) tokens = 0;
      const resetAt = allowed
        ? now + Math.ceil(((cap - tokens) / refill) * 1000)
        : now + Math.ceil(((1 - tokens) / refill) * 1000);
      return { allowed, remaining: Math.max(0, Math.floor(tokens)), resetAt };
    },
  };
}

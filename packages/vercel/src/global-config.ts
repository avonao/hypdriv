import { HypDrivError, type KVNamespaceLike, readEnv, utf8Encode } from '@hypdriv/core';
import { fetchWithTimeout } from './util';

/** A parsed Global Config (formerly Edge Config) connection string. */
export interface GlobalConfigConnection {
  /** `vercel` for Vercel-hosted stores, `external` for self-hosted compatible endpoints. */
  type: 'vercel' | 'external';
  id: string;
  token: string;
  /** Read endpoint without trailing slash, e.g. `https://global-config.vercel.com/ecfg_abc`. */
  baseUrl: string;
  version: string;
}

const VERCEL_HOSTS = new Set(['global-config.vercel.com', 'edge-config.vercel.com']);

/**
 * Parses every connection string form the Vercel SDKs accept: `https://global-config.vercel.com/<id>?token=…`,
 * the legacy `https://edge-config.vercel.com/ecfg_…?token=…`, `edge-config:id=…&token=…`, and external URLs
 * carrying `id`/`token` (and optionally `version`) query parameters. Returns `null` for anything else.
 */
export function parseGlobalConfigConnection(connectionString: string): GlobalConfigConnection | null {
  const text = (connectionString ?? '').trim();
  if (!text) return null;
  if (text.startsWith('edge-config:')) {
    const params = new URLSearchParams(text.slice('edge-config:'.length));
    const id = params.get('id');
    const token = params.get('token');
    if (!id || !token) return null;
    return { type: 'vercel', id, token, baseUrl: `https://edge-config.vercel.com/${id}`, version: '1' };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const token = url.searchParams.get('token');
  if (!token) return null;
  if (VERCEL_HOSTS.has(url.host)) {
    if (url.protocol !== 'https:') return null;
    const id = url.pathname.split('/')[1];
    if (!id) return null;
    return { type: 'vercel', id, token, baseUrl: `https://${url.host}/${id}`, version: '1' };
  }
  let id = url.searchParams.get('id');
  if (!id || url.pathname.startsWith('/ecfg_')) id = url.pathname.split('/')[1] || null;
  if (!id) return null;
  const version = url.searchParams.get('version') || '1';
  url.search = '';
  url.hash = '';
  return { type: 'external', id, token, baseUrl: url.href.replace(/\/+$/, ''), version };
}

/** Options of `globalConfigKv`. */
export interface GlobalConfigKvOptions {
  fetch?: typeof fetch;
  /** How long a read is reused per key, in milliseconds (default 1000). */
  cacheTtlMs?: number;
  /** Clock in epoch milliseconds (tests). */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 3000). */
  timeoutMs?: number;
}

/** Read-only KV namespace over a Global Config store. */
export type GlobalConfigKv = KVNamespaceLike & {
  readonly name: 'global-config';
  readonly connection: Readonly<Omit<GlobalConfigConnection, 'token'>>;
};

interface CacheEntry {
  /** `undefined` when the key does not exist. */
  value: unknown;
  expiresAt: number;
}

const KEY_RE = /^[\w-]{1,256}$/;
const MISSING: unique symbol = Symbol('missing');

/**
 * A read-only `KVNamespaceLike` over Vercel Global Config (formerly Edge Config), read through the
 * `global-config.vercel.com` endpoint (`GET /<id>/item/<key>?version=1`, `Authorization: Bearer <read token>`):
 * the low-latency, globally replicated, un-rate-limited read path the official SDK uses. Ideal for flags,
 * redirect tables and the maintenance switch.
 *
 * `get(key, 'json')` returns the stored JSON value; `get(key)` returns a string (JSON-stringified when the
 * value is not a string); missing keys are `null`. Reads are cached per key for `cacheTtlMs` and concurrent
 * reads of one key share a request; when a refresh fails, the last known value is served. `list()` reads
 * the whole store (`/items`). Writes go through the Vercel REST API or dashboard, so `put`/`delete` throw
 * `HypDrivError('E_UNSUPPORTED')`.
 */
export function globalConfigKv(connectionString: string, options: GlobalConfigKvOptions = {}): GlobalConfigKv {
  const connection = parseGlobalConfigConnection(connectionString);
  if (!connection)
    throw new HypDrivError(
      'E_CONFIG',
      'globalConfigKv: unrecognised connection string (expected https://global-config.vercel.com/<id>?token=<token>)',
    );
  const doFetch = options.fetch ?? fetch;
  const ttl = Math.max(0, options.cacheTtlMs ?? 1000);
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 3000;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { authorization: `Bearer ${connection.token}` };
    const vercelEnv = readEnv(undefined, 'VERCEL_ENV');
    if (vercelEnv) h['x-edge-config-vercel-env'] = vercelEnv;
    return h;
  };

  const fail = (status: number): never => {
    if (status === 401 || status === 403)
      throw new HypDrivError('E_UNAUTHORIZED', `Global Config ${connection.id}: read token rejected (HTTP ${status})`);
    if (status === 404) throw new HypDrivError('E_NOT_FOUND', `Global Config ${connection.id} does not exist`);
    throw new HypDrivError('E_UPSTREAM', `Global Config ${connection.id}: HTTP ${status}`, { status });
  };

  const fetchItem = async (key: string): Promise<unknown> => {
    const url = `${connection.baseUrl}/item/${encodeURIComponent(key)}?version=${encodeURIComponent(connection.version)}`;
    const res = await fetchWithTimeout(doFetch, url, { headers: headers() }, timeoutMs, 'global-config');
    if (res.ok) return (await res.json()) as unknown;
    void res.body?.cancel().catch(() => undefined);
    // A 404 with a digest header means "store exists, key does not".
    if (res.status === 404 && res.headers.has('x-edge-config-digest')) return MISSING;
    return fail(res.status);
  };

  const read = (key: string): Promise<unknown> => {
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > t) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = fetchItem(key)
      .then((result) => {
        const value = result === MISSING ? undefined : result;
        cache.set(key, { value, expiresAt: now() + ttl });
        return value;
      })
      .catch((error: unknown) => {
        // Serve the last known value while the endpoint is unreachable (stale-if-error), and back off for
        // one TTL so a failing endpoint is not hit on every request.
        if (hit) {
          cache.set(key, { value: hit.value, expiresAt: now() + ttl });
          return hit.value;
        }
        throw error;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };

  async function get(key: string, type?: unknown): Promise<unknown> {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    const value = await read(key);
    if (value === undefined) return null;
    const kind = typeof type === 'string' ? type : ((type as { type?: string } | undefined)?.type ?? 'text');
    if (kind === 'json') return value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (kind === 'arrayBuffer') {
      const bytes = utf8Encode(text);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return text;
  }

  const readOnly = (operation: string): never => {
    throw new HypDrivError(
      'E_UNSUPPORTED',
      `Global Config is read-only at run time (${operation}); write items with the Vercel REST API (PATCH /v1/global-config/${connection.id}/items) or the dashboard`,
    );
  };

  return {
    name: 'global-config',
    connection: { type: connection.type, id: connection.id, baseUrl: connection.baseUrl, version: connection.version },
    get: get as KVNamespaceLike['get'],
    async put() {
      readOnly('put');
    },
    async delete() {
      readOnly('delete');
    },
    async list(listOptions = {}) {
      const url = `${connection.baseUrl}/items?version=${encodeURIComponent(connection.version)}`;
      const res = await fetchWithTimeout(doFetch, url, { headers: headers() }, timeoutMs, 'global-config');
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        fail(res.status);
      }
      const items = ((await res.json()) ?? {}) as Record<string, unknown>;
      const t = now();
      for (const [key, value] of Object.entries(items)) cache.set(key, { value, expiresAt: t + ttl });
      const prefix = listOptions.prefix ?? '';
      const names = Object.keys(items)
        .filter((name) => name.startsWith(prefix))
        .sort();
      const offset = Math.max(0, Number.parseInt(listOptions.cursor ?? '0', 10) || 0);
      const limit = Math.max(1, Math.min(1000, listOptions.limit ?? 1000));
      const page = names.slice(offset, offset + limit);
      const next = offset + page.length;
      const complete = next >= names.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(next) }),
      };
    },
  };
}

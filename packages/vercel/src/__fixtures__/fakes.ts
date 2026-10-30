import {
  digest,
  emptyManifest,
  type HypManifest,
  type HypRoute,
  hexEncode,
  type Logger,
  routePatternToRegex,
} from '@hypdriv/core';
import { TOKEN_BUCKET_SCRIPT } from '../upstash';

interface Entry {
  value: string | Map<string, string>;
  expiresAt?: number;
}

export interface FakeUpstash {
  fetch: typeof fetch;
  data: Map<string, Entry>;
  /** Every command executed, in order (pipelines flattened). */
  commands: Array<Array<string | number>>;
  /** Raw requests: path and parsed body. */
  requests: Array<{ path: string; body: unknown; authorization: string | null }>;
  /** Make the next request fail with this HTTP status and JSON body. */
  failNext(status: number, body?: unknown): void;
  now: () => number;
  setNow(ms: number): void;
}

function globToRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    } else if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** In-memory Upstash REST endpoint implementing the commands `@hypdriv/vercel` sends. */
export function createFakeUpstash(
  options: { token?: string; start?: number; scanPage?: number } = {},
): FakeUpstash {
  const token = options.token ?? 'test-token';
  let clock = options.start ?? 1_700_000_000_000;
  const data = new Map<string, Entry>();
  const commands: FakeUpstash['commands'] = [];
  const requests: FakeUpstash['requests'] = [];
  const scripts = new Set<string>();
  let failure: { status: number; body: unknown } | null = null;
  const scanPage = options.scanPage ?? 2;

  const live = (key: string): Entry | undefined => {
    const e = data.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= clock) {
      data.delete(key);
      return undefined;
    }
    return e;
  };

  const tokenBucket = (key: string, args: Array<string | number>) => {
    const [capacity, refill, now, ttl] = args.map(Number) as [number, number, number, number];
    const entry = live(key);
    const hash = entry?.value instanceof Map ? entry.value : new Map<string, string>();
    let tokens = hash.has('tokens') ? Number(hash.get('tokens')) : Number.NaN;
    const updated = hash.has('updatedAt') ? Number(hash.get('updatedAt')) : Number.NaN;
    if (Number.isNaN(tokens) || Number.isNaN(updated)) tokens = capacity;
    else tokens = Math.min(capacity, tokens + (Math.max(0, now - updated) / 1000) * refill);
    if (Number.isNaN(tokens) || tokens < 0) tokens = capacity;
    let allowed = 0;
    if (tokens >= 1) {
      allowed = 1;
      tokens -= 1;
    }
    hash.set('tokens', String(tokens));
    hash.set('updatedAt', String(now));
    data.set(key, { value: hash, expiresAt: clock + ttl });
    return [allowed, String(tokens)];
  };

  const run = async (cmd: Array<string | number>): Promise<{ result?: unknown; error?: string }> => {
    commands.push(cmd);
    const name = String(cmd[0]).toUpperCase();
    const key = String(cmd[1]);
    switch (name) {
      case 'GET': {
        const e = live(key);
        return { result: e && typeof e.value === 'string' ? e.value : null };
      }
      case 'SET': {
        const entry: Entry = { value: String(cmd[2]) };
        for (let i = 3; i < cmd.length; i += 2) {
          const opt = String(cmd[i]).toUpperCase();
          if (opt === 'EX') entry.expiresAt = clock + Number(cmd[i + 1]) * 1000;
          if (opt === 'EXAT') entry.expiresAt = Number(cmd[i + 1]) * 1000;
        }
        data.set(key, entry);
        return { result: 'OK' };
      }
      case 'DEL':
        return { result: data.delete(key) ? 1 : 0 };
      case 'INCR': {
        const e = live(key);
        const next = (e ? Number(e.value) : 0) + 1;
        data.set(key, {
          value: String(next),
          ...(e?.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}),
        });
        return { result: next };
      }
      case 'PEXPIRE': {
        const e = live(key);
        if (!e) return { result: 0 };
        if (String(cmd[3] ?? '').toUpperCase() === 'NX' && e.expiresAt !== undefined) return { result: 0 };
        e.expiresAt = clock + Number(cmd[2]);
        return { result: 1 };
      }
      case 'SCAN': {
        const cursor = Number(cmd[1]);
        const matchIndex = cmd.findIndex((c) => String(c).toUpperCase() === 'MATCH');
        const regex = globToRegex(matchIndex >= 0 ? String(cmd[matchIndex + 1]) : '*');
        const keys = [...data.keys()].filter((k) => live(k)).sort();
        const page = keys.slice(cursor, cursor + scanPage);
        const next = cursor + scanPage >= keys.length ? '0' : String(cursor + scanPage);
        return { result: [next, page.filter((k) => regex.test(k))] };
      }
      case 'EVAL': {
        const script = String(cmd[1]);
        if (script !== TOKEN_BUCKET_SCRIPT) return { error: 'ERR unknown script' };
        scripts.add(hexEncode(await digest(script, 'SHA-1')));
        return { result: tokenBucket(String(cmd[3]), cmd.slice(4)) };
      }
      case 'EVALSHA': {
        if (!scripts.has(String(cmd[1]))) return { error: 'NOSCRIPT No matching script. Please use EVAL.' };
        return { result: tokenBucket(String(cmd[3]), cmd.slice(4)) };
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    requests.push({ path: url.pathname, body, authorization: headers.get('authorization') });
    if (failure) {
      const f = failure;
      failure = null;
      return new Response(JSON.stringify(f.body ?? { error: 'failure' }), { status: f.status });
    }
    if (headers.get('authorization') !== `Bearer ${token}`)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    if (url.pathname.endsWith('/pipeline')) {
      const out = [];
      for (const cmd of body as Array<Array<string | number>>) out.push(await run(cmd));
      return Response.json(out);
    }
    const result = await run(body as Array<string | number>);
    return Response.json(result, { status: result.error ? 400 : 200 });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    data,
    commands,
    requests,
    failNext(status, body) {
      failure = { status, body };
    },
    now: () => clock,
    setNow(ms) {
      clock = ms;
    },
  };
}

export function makeRoute(partial: Partial<HypRoute> & Pick<HypRoute, 'pathname'>): HypRoute {
  const kind = partial.kind ?? 'app-page';
  return {
    id: `${kind === 'app-page' ? 'app' : kind === 'app-route' ? 'route' : kind}:${partial.pathname}`,
    regex: routePatternToRegex(partial.pathname),
    kind,
    classification: 'static',
    runtime: 'nodejs',
    dynamic: /\[/.test(partial.pathname),
    assets: { js: [], css: [], fonts: [] },
    ...partial,
  };
}

export function makeManifest(routes: HypRoute[], partial: Partial<HypManifest> = {}): HypManifest {
  return emptyManifest({ buildId: 'build-1', routes, ...partial });
}

export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

/** A logger that records every line. */
export function captureLogger(): Logger & { lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  const make = (): Logger & { lines: CapturedLog[] } => ({
    level: 'debug',
    lines,
    debug: (message, fields) => void lines.push({ level: 'debug', message, ...(fields ? { fields } : {}) }),
    info: (message, fields) => void lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => void lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => void lines.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
    child: () => make(),
  });
  return make();
}

/** A `fetch` double that records calls and answers from a queue of responders. */
export function scriptedFetch(
  ...responders: Array<(url: string, init: RequestInit | undefined) => Response | Promise<Response>>
): typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined; body: unknown }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined; body: unknown }> = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    calls.push({ url, init, body });
    const responder = responders[Math.min(i, responders.length - 1)];
    i++;
    if (!responder) throw new Error('scriptedFetch: no responder');
    return responder(url, init);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

import type { ResolvedConfig } from './config/resolved';

export interface Capabilities {
  /** Workers `caches.default` is available. */
  cacheApi: boolean;
  kv: boolean;
  tagIndex: boolean;
  limiter: boolean;
  channel: boolean;
  rateLimitBinding: boolean;
  analyticsEngine: boolean;
  images: boolean;
  assets: boolean;
  queues: string[];
  ai: boolean;
  /** `waitUntil` is available (Workers / proxy event). */
  waitUntil: boolean;
  /** `request.cf` present. */
  cf: boolean;
  /** HTMLRewriter available (Workers). */
  htmlRewriter: boolean;
  asyncLocalStorage: boolean;
  /**
   * Platform services that replace a capability outside Cloudflare (Vercel CDN, Upstash, Vercel Queues…),
   * keyed by the `describeCapabilities` line they describe.
   */
  services?: Partial<Record<CapabilityLine, string>>;
}

/** The lines of `describeCapabilities`. */
export type CapabilityLine =
  | 'cache'
  | 'tag purge'
  | 'rate limiting'
  | 'config store'
  | 'live channels'
  | 'vitals/traces sink'
  | 'images'
  | 'queues';

function isNamespaceLike(value: unknown, methods: string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  return methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function');
}

/** Detects which optional capabilities the current `env` offers (ADR 0004). Pure and cheap; cache per isolate. */
export function detectCapabilities(
  env: Record<string, unknown>,
  config: ResolvedConfig,
  extra: { cf?: boolean; waitUntil?: boolean } = {},
): Capabilities {
  const b = config.cloudflare.bindings;
  const caches = (globalThis as { caches?: { default?: unknown; open?: unknown } }).caches;
  return {
    cacheApi: !!caches && (typeof caches.default === 'object' || typeof caches.open === 'function'),
    kv: isNamespaceLike(env[b.kv], ['get', 'put']),
    tagIndex: isNamespaceLike(env[b.tagIndex], ['idFromName', 'get']),
    limiter: isNamespaceLike(env[b.limiter], ['idFromName', 'get']),
    channel: isNamespaceLike(env[b.channel], ['idFromName', 'get']),
    rateLimitBinding: isNamespaceLike(env[b.rateLimit], ['limit']),
    analyticsEngine: isNamespaceLike(env[b.analyticsEngine], ['writeDataPoint']),
    images: isNamespaceLike(env[b.images], ['input']),
    assets: isNamespaceLike(env[b.assets], ['fetch']),
    queues: Object.entries(b.queues)
      .filter(([, binding]) => isNamespaceLike(env[binding], ['send']))
      .map(([name]) => name),
    ai: isNamespaceLike(env[b.ai], ['run']),
    waitUntil: extra.waitUntil ?? false,
    cf: extra.cf ?? false,
    htmlRewriter: typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter === 'function',
    asyncLocalStorage: false,
  };
}

/** Human-readable summary used by `hypdriv doctor` and the HUD. */
export function describeCapabilities(c: Capabilities): string[] {
  const line = (key: CapabilityLine, fallback: string) => `${key}: ${c.services?.[key] ?? fallback}`;
  return [
    line(
      'cache',
      c.kv
        ? 'tiered (memory → Cache API → KV)'
        : c.cacheApi
          ? 'Cache API (per colo)'
          : 'memory (per isolate)',
    ),
    line('tag purge', c.tagIndex ? 'exact (Durable Object index)' : c.kv ? 'KV index' : 'TTL/SWR bounded'),
    line(
      'rate limiting',
      c.limiter
        ? 'exact (Durable Object)'
        : c.rateLimitBinding
          ? 'Rate Limiting binding (per colo)'
          : c.cacheApi
            ? 'approximate (Cache API)'
            : 'per isolate',
    ),
    // Where flags, redirect rules and the maintenance switch are read at run time (no redeploy needed).
    line('config store', c.kv ? 'Workers KV' : 'none (hypdriv.config only)'),
    line('live channels', c.channel ? 'Durable Object (SSE/WebSocket)' : 'polling fallback'),
    line('vitals/traces sink', c.analyticsEngine ? 'Analytics Engine' : 'logs'),
    line('images', c.images ? 'Images binding' : 'loader only'),
    line('queues', c.queues.length ? c.queues.join(', ') : 'none (in-process fallback)'),
  ];
}

import { type CacheStore, createMemoryStore, type Purger } from '@hypdriv/cache';
import {
  type Capabilities,
  detectCapabilities,
  type Logger,
  queueEnvKey,
  type RateLimitBindingLike,
  type RateLimitStore,
  type Stage,
  shortHash,
} from '@hypdriv/core';
import { type CounterStore, createMemoryCounterStore } from '@hypdriv/security';
import { type VercelCdnOptions, vercelCdnStage } from './cdn';
import { vercelRateLimitRouter, vercelRateLimitStage } from './firewall';
import { type GlobalConfigKv, globalConfigKv, parseGlobalConfigConnection } from './global-config';
import { toPlatformPurger, type VercelPurger, vercelPurger } from './purge';
import { vercelQueue } from './queues';
import { type UpstashKv, upstashCounterStore, upstashKv } from './upstash';
import { type ConfigInput, defaultLogger, readFirstEnv, resolveInput, warnOnce } from './util';

/** The env key under which `vercelEnv` exposes Upstash Redis as a KV namespace (always read-write). */
export const REDIS_BINDING = 'HYPDRIV_REDIS';

/** Upstash credentials resolved from `vercel.redis` (`KV_REST_API_*`, then `UPSTASH_REDIS_REST_*`). */
export function resolveRedis(
  configInput: ConfigInput,
  env: Record<string, unknown>,
): { url: string; token: string; prefix: string } | null {
  const config = resolveInput(configInput);
  const redis = config.vercel.redis;
  if (!redis) return null;
  const url = readFirstEnv(env, redis.urlEnv);
  const token = readFirstEnv(env, redis.tokenEnv);
  return url && token ? { url, token, prefix: redis.prefix } : null;
}

/** The Global Config connection string from `vercel.globalConfig.connectionEnv` (`GLOBAL_CONFIG`, then `EDGE_CONFIG`). */
export function resolveGlobalConfig(configInput: ConfigInput, env: Record<string, unknown>): string | null {
  const config = resolveInput(configInput);
  const gc = config.vercel.globalConfig;
  if (!gc) return null;
  return readFirstEnv(env, gc.connectionEnv) ?? null;
}

function isKvLike(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { put?: unknown }).put === 'function'
  );
}

/** `true` for a namespace whose writes always fail (Global Config). */
function isReadOnlyKv(value: unknown): value is GlobalConfigKv {
  return isKvLike(value) && (value as { name?: unknown }).name === 'global-config';
}

/** Instances are reused per connection so per-key caches survive repeated `vercelEnv` calls. */
const instances = new Map<string, UpstashKv | GlobalConfigKv>();

function memo<T extends UpstashKv | GlobalConfigKv>(key: string, custom: boolean, create: () => T): T {
  if (custom) return create();
  const hit = instances.get(key) as T | undefined;
  if (hit) return hit;
  const created = create();
  instances.set(key, created);
  return created;
}

/** Options of `vercelEnv` / `vercelPlatformOverrides`. */
export interface VercelEnvOptions {
  fetch?: typeof fetch;
  log?: Logger;
}

/**
 * Returns `env` plus the Vercel-backed bindings Hypdriv knows how to use, without replacing bindings that
 * already exist:
 *
 * - the generic KV binding (`cloudflare.bindings.kv`, and the flags/redirects/maintenance KV bindings when they
 *   differ): Global Config when a connection string exists (those consumers only read), otherwise Upstash
 *   Redis when its credentials exist;
 * - `HYPDRIV_REDIS`: Upstash Redis (read-write) when configured;
 * - `HYPDRIV_QUEUE:<name>`: a Vercel Queues producer for every configured queue (`enqueue()` uses it once
 *   `@vercel/queue` is registered).
 */
export function vercelEnv(
  configInput: ConfigInput,
  env: Record<string, unknown>,
  options: VercelEnvOptions = {},
): Record<string, unknown> {
  const config = resolveInput(configInput);
  const out: Record<string, unknown> = { ...env };
  const custom = options.fetch !== undefined;
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};

  let redis: UpstashKv | null = null;
  const redisConfig = resolveRedis(config, env);
  if (redisConfig) {
    redis = memo(
      `upstash|${redisConfig.url}|${redisConfig.prefix}|${shortHash(redisConfig.token)}`,
      custom,
      () => upstashKv({ ...redisConfig, ...fetchOption }),
    );
  }

  let globalConfig: GlobalConfigKv | null = null;
  const connection = resolveGlobalConfig(config, env);
  if (connection) {
    if (parseGlobalConfigConnection(connection)) {
      globalConfig = memo(`global-config|${shortHash(connection)}`, custom, () =>
        globalConfigKv(connection, fetchOption),
      );
    } else {
      warnOnce(
        options.log ?? defaultLogger(),
        'vercel-env:global-config-invalid',
        'vercel: the Global Config connection string is not recognised; Global Config is not used',
        { env: config.vercel.globalConfig?.connectionEnv },
      );
    }
  }

  // Queue producers for `enqueue()`: Vercel Queues per Hypdriv queue name (ready once `@vercel/queue` is
  // registered with `registerVercelSdk`; until then `enqueue()` calls the consumer route inline).
  const queueNames = new Set([
    ...Object.keys(config.jobs.queues),
    ...Object.keys(config.vercel.queues),
    ...Object.keys(config.cloudflare.bindings.queues),
  ]);
  for (const name of queueNames) {
    const key = queueEnvKey(name);
    if (!out[key]) out[key] = vercelQueue(name, config);
  }

  if (redis && !isKvLike(out[REDIS_BINDING])) out[REDIS_BINDING] = redis;
  const kv = globalConfig ?? redis;
  if (kv) {
    const names = new Set(
      [
        config.cloudflare.bindings.kv,
        config.flags.kvBinding,
        config.redirects.kvBinding,
        config.maintenance.kvBinding,
      ].filter((name): name is string => typeof name === 'string' && name.length > 0),
    );
    for (const name of names) if (!isKvLike(out[name])) out[name] = kv;
  }
  return out;
}

/** The `overrides` for `createPlatform` (`@hypdriv/next/stages`) on Vercel. */
export interface VercelPlatformOverrides {
  capabilities: Capabilities;
  /** `vercelPurger` adapted to the platform's `Purger` slot (reached through the edge cache's purge). */
  purger: Purger;
  /**
   * The same purger with purge counts. Not a `createPlatform` override: register it with
   * `registerEdgePurger` on Vercel so `purgeEdge()` / `revalidateTag()` report what Vercel purged (the edge
   * cache's own store is unused when `vercelCdnStage` replaces its stage).
   */
  edgePurger: VercelPurger;
  /** Default counter store for `store: 'auto'` policies: Upstash (exact, global) when configured. */
  counterStore?: CounterStore;
  counterStores?: Partial<Record<RateLimitStore, CounterStore>>;
  /** WAF binding for policies with `store: 'binding'` (see `vercelRateLimitRouter`). */
  rateLimitBinding?: RateLimitBindingLike;
  /** Memory store when the KV binding is read-only Global Config (KV-backed cache stores cannot write to it). */
  cacheStore?: CacheStore;
}

/**
 * Builds the `createPlatform` overrides for Vercel from the (augmented) environment:
 *
 * - `capabilities`: core `detectCapabilities` over `vercelEnv(config, env)` (KV from Global Config/Upstash,
 *   `waitUntil` available, no `request.cf`, no Cache API);
 * - `counterStore` / `counterStores.kv`: Upstash when configured; otherwise, when the KV binding is read-only
 *   Global Config, a memory store replaces the KV counter store (with a one-time warning);
 * - `rateLimitBinding`: the WAF router when `vercel.firewall.rateLimitRules` has entries (the SDK is resolved at
 *   call time, so registering it later still works);
 * - `purger`: `vercelPurger` (adapted to the `Purger` slot; `edgePurger` is the same purger with counts);
 * - `cacheStore`: a memory store when the KV binding is read-only.
 */
export function vercelPlatformOverrides(
  configInput: ConfigInput,
  env: Record<string, unknown>,
  options: VercelEnvOptions = {},
): VercelPlatformOverrides {
  const config = resolveInput(configInput);
  const log = options.log ?? defaultLogger();
  const augmented = vercelEnv(config, env, options);
  const edgePurger = vercelPurger({
    env: augmented,
    config,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    log,
  });
  const capabilities = detectCapabilities(augmented, config, { cf: false, waitUntil: true });
  const redisReady = resolveRedis(config, augmented) !== null;
  const configStore = augmented[config.flags.kvBinding] ?? augmented[config.cloudflare.bindings.kv];
  const wafRules = Object.keys(config.vercel.firewall.rateLimitRules).length;
  const queueNames = [...new Set([...Object.keys(config.jobs.queues), ...Object.keys(config.vercel.queues)])];
  capabilities.services = {
    cache: config.vercel.cdn
      ? 'Vercel CDN (Vercel-CDN-Cache-Control, Vercel-Cache-Tag)'
      : 'memory (per instance)',
    'tag purge': 'Vercel CDN tag purge (request context, REST with VERCEL_TOKEN)',
    'config store': isReadOnlyKv(configStore)
      ? 'Global Config (read-only; flags, redirects, maintenance)'
      : isKvLike(configStore)
        ? 'Upstash Redis'
        : 'none (hypdriv.config only)',
    'rate limiting': [
      redisReady ? 'exact (Upstash Redis)' : 'per instance',
      ...(wafRules ? [`Vercel WAF (${wafRules} rule${wafRules === 1 ? '' : 's'})`] : []),
    ].join(' + '),
    images: 'Vercel Image Optimization',
    queues: queueNames.length
      ? `Vercel Queues (${queueNames.join(', ')}; consumer route until @vercel/queue is registered)`
      : 'none',
  };
  const overrides: VercelPlatformOverrides = {
    capabilities,
    purger: toPlatformPurger(edgePurger),
    edgePurger,
  };
  const kvReadOnly = isReadOnlyKv(augmented[config.cloudflare.bindings.kv]);
  const redis = resolveRedis(config, augmented);
  if (redis) {
    const store = upstashCounterStore({ ...redis, ...(options.fetch ? { fetch: options.fetch } : {}) });
    overrides.counterStore = store;
    overrides.counterStores = { kv: store };
  } else if (kvReadOnly) {
    overrides.counterStores = { kv: createMemoryCounterStore() };
    if (config.security.rateLimit.some((p) => p.store === 'kv'))
      warnOnce(
        log,
        'vercel-platform:kv-counters',
        'vercel: rate-limit policies with store "kv" use per-instance memory counters because the KV binding is read-only Global Config; configure Upstash Redis (vercel.redis) for global counters',
      );
  }
  if (kvReadOnly) overrides.cacheStore = createMemoryStore();
  const binding = vercelRateLimitRouter(config, { log });
  if (binding) overrides.rateLimitBinding = binding;
  return overrides;
}

/** Options of `vercelStages`. */
export interface VercelStagesOptions extends VercelCdnOptions {
  /** Timeout of WAF checks in the `rate-limit-vercel` stage (default 2000 ms). */
  wafTimeoutMs?: number;
}

/**
 * Adapts the default stage list for Vercel:
 *
 * - `edge-cache` is replaced by `vercelCdnStage` (kept as is when `vercel.cdn` is disabled);
 * - `rate-limit-vercel` (`vercelRateLimitStage`) is inserted after `rate-limit` when WAF rules are mapped;
 * - `html-transforms` is removed (there is no streaming body rewriting on Vercel).
 *
 * Pass it as the `stages` callback (`createProxy(config, vercelStages(config))`).
 */
export function vercelStages(
  configInput: ConfigInput,
  options: VercelStagesOptions = {},
): (defaults: Stage[]) => Stage[] {
  const config = resolveInput(configInput);
  return (defaults) => {
    const cdn = vercelCdnStage(config, options);
    const waf = vercelRateLimitStage(
      config,
      options.wafTimeoutMs !== undefined ? { timeoutMs: options.wafTimeoutMs } : {},
    );
    const out: Stage[] = [];
    let wafPlaced = !waf;
    for (const stage of defaults) {
      if (stage.name === 'html-transforms') continue;
      if (stage.name === 'edge-cache') {
        out.push(cdn ?? stage);
        continue;
      }
      if (stage.name === 'rate-limit-vercel') continue;
      out.push(stage);
      if (stage.name === 'rate-limit' && waf) {
        out.push(waf);
        wafPlaced = true;
      }
    }
    if (!wafPlaced && waf) {
      // No `rate-limit` stage (no local policies matched the list): run right after the earliest guard.
      const anchor = ['bots', 'shield', 'maintenance', 'request-id']
        .map((name) => out.findIndex((s) => s.name === name))
        .find((index) => index >= 0);
      out.splice(anchor === undefined ? 0 : anchor + 1, 0, waf);
    }
    return out;
  };
}

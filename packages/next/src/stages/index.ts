import type { CacheStore, Purger, TagIndex } from '@hypdriv/cache';
import { createEdgeCache, createMemoryStore, createMemoryTagIndex, createZonePurger, selectStore } from '@hypdriv/cache';
import {
  type Capabilities,
  type HypDrivEnv,
  type HypManifest,
  type Logger,
  type RateLimitBindingLike,
  type ResolvedConfig,
  type RouteMatcher,
  type Runner,
  type Stage,
  createConsoleLogger,
  createRouteMatcher,
  detectCapabilities,
  emptyManifest,
  orderStages,
  type RateLimitStore,
  readEnv,
} from '@hypdriv/core';
import { FLAGS_KEY, type FlagProvider, envProvider, flagsStage, kvProvider, staticProvider } from '@hypdriv/flags';
import { type SpanExporter, type Tracer, type VitalsSink, analyticsEngineExporter, analyticsEngineVitalsSink, consoleExporter, createLogger, createTracer, logVitalsSink, noopExporter, observeStage, otlpHttpExporter, requestIdStage } from '@hypdriv/observe';
import { themeStage } from '@hypdriv/purser';
import { type CounterStore, botsStage, createCacheApiCounterStore, createKvCounterStore, createMemoryCounterStore, createRateLimiter, cspStage, csrfStage, rateLimitStage, securityHeadersStage, shieldStage, verifyTurnstile } from '@hypdriv/security';
import { earlyHintsStage } from './early-hints';
import { geoStage } from './geo';
import { LOCALE_KEY, i18nStage } from './i18n';
import { maintenanceStage } from './maintenance';
import { redirectsStage } from './redirects';
import { skewStage } from './skew';
import { speculationStage } from './speculation';

export { GEO_KEY, geoStage, geoFrom, encodeGeoHeader, decodeGeoHeader, type GeoInfo } from './geo';
export { LOCALE_KEY, i18nStage, negotiateLocale, splitLocale } from './i18n';
export { redirectsStage, matchRedirect, expandDestination } from './redirects';
export { maintenanceStage, renderMaintenancePage } from './maintenance';
export { earlyHintsStage } from './early-hints';
export { speculationStage, SPECULATION_KEY } from './speculation';
export { skewStage } from './skew';
export { linkEntriesForRoute, linkHeaderValues } from '../shared/hints';
export { buildSpeculationRules, speculationScript, speculationScriptHash } from '../shared/speculation';

/** Everything the stages need from the host runtime (ADR 0004: stores are chosen from capabilities). */
export interface Platform {
  config: ResolvedConfig;
  manifest: HypManifest;
  matcher: RouteMatcher;
  capabilities: Capabilities;
  env: HypDrivEnv;
  runner: Runner;
  development: boolean;
  log: Logger;
  cacheStore: CacheStore;
  tagIndex: TagIndex;
  purger: Purger | null;
  /** Default counter store for `store: 'auto'` policies (the best one available). */
  counterStore: CounterStore;
  /** Counter stores by kind, for policies that pin `store` (`memory`, `cache-api`, `kv`, `durable-object`). */
  counterStores: Partial<Record<RateLimitStore, CounterStore>>;
  rateLimitBinding: RateLimitBindingLike | null;
  flagsProvider: FlagProvider;
  tracer: Tracer | null;
  vitalsSink: VitalsSink | null;
  turnstileVerify: ((token: string, ip: string) => Promise<boolean>) | null;
  /** Cache engine instance (shared with `purgeEdge`). */
  edgeCache: ReturnType<typeof createEdgeCache> | null;
}

export interface CreatePlatformInput {
  config: ResolvedConfig;
  manifest: HypManifest | null;
  env: HypDrivEnv;
  runner: Runner;
  development?: boolean;
  log?: Logger;
  /** Overrides for tests and the Worker shell (Durable Object stores etc.). */
  overrides?: Partial<Pick<Platform, 'cacheStore' | 'tagIndex' | 'purger' | 'counterStore' | 'counterStores' | 'rateLimitBinding' | 'flagsProvider' | 'tracer' | 'vitalsSink' | 'turnstileVerify' | 'capabilities'>>;
}

/**
 * Builds the tracer described by `observe.tracing` (OTLP/HTTP with headers from `headersEnv`, console,
 * Analytics Engine when the binding exists); null when tracing is off.
 */
export function createConfiguredTracer(config: ResolvedConfig, env: HypDrivEnv, caps: Pick<Capabilities, 'analyticsEngine'>): Tracer | null {
  return tracerFor(config, env, caps);
}

function tracerFor(config: ResolvedConfig, env: HypDrivEnv, caps: Pick<Capabilities, 'analyticsEngine'>): Tracer | null {
  const t = config.observe.tracing;
  if (!t || t.exporter === 'none') return null;
  let exporter: SpanExporter;
  if (t.exporter === 'otlp' && t.otlp) {
    const headers = { ...t.otlp.headers };
    if (t.otlp.headersEnv) {
      const raw = readEnv(env, t.otlp.headersEnv);
      if (raw) {
        for (const pair of raw.split(',')) {
          const [k, ...rest] = pair.split('=');
          if (k && rest.length) headers[k.trim()] = rest.join('=').trim();
        }
      }
    }
    exporter = otlpHttpExporter({ url: t.otlp.url, headers, timeoutMs: t.otlp.timeoutMs });
  } else if (t.exporter === 'analytics-engine' && caps.analyticsEngine) {
    exporter = analyticsEngineExporter(env[t.analyticsEngineBinding] as never);
  } else if (t.exporter === 'console' || t.exporter === 'otlp' || t.exporter === 'analytics-engine') {
    exporter = t.exporter === 'console' ? consoleExporter() : noopExporter();
  } else {
    exporter = noopExporter();
  }
  return createTracer({ serviceName: t.serviceName, exporter, sampleRate: t.sampleRate });
}

function flagsProviderFor(config: ResolvedConfig, env: HypDrivEnv, caps: Capabilities): FlagProvider {
  const f = config.flags;
  if (f.provider === 'env') return envProvider(env, f.envVar, f.definitions);
  if (f.provider === 'kv' && caps.kv) return kvProvider(env[f.kvBinding] as never, f.kvKey, f.definitions, f.refreshSeconds);
  return staticProvider(f.definitions);
}

/** Assembles the platform: capabilities, stores, providers and the route matcher. */
export function createPlatform(input: CreatePlatformInput): Platform {
  const { config, env, runner } = input;
  const manifest = input.manifest ?? emptyManifest();
  const development = input.development ?? false;
  const log = input.log ?? createLogger(config.observe.logging, { service: config.site.name, runner });
  const capabilities = input.overrides?.capabilities ?? detectCapabilities(env as Record<string, unknown>, config, { cf: runner === 'worker', waitUntil: runner !== 'node' });
  const edge = config.cache.edge;
  const cacheStore = input.overrides?.cacheStore ?? (edge ? selectStore(edge.store, capabilities, env, config) : createMemoryStore());
  const tagIndex = input.overrides?.tagIndex ?? createMemoryTagIndex();
  let purger: Purger | null = input.overrides?.purger ?? null;
  if (!purger && edge) {
    const zoneId = readEnv(env, edge.purge.zoneIdEnv);
    const token = readEnv(env, edge.purge.tokenEnv);
    if (zoneId && token) purger = createZonePurger({ zoneId, token });
  }
  const counterStores: Partial<Record<RateLimitStore, CounterStore>> = {
    memory: createMemoryCounterStore(),
    ...(capabilities.cacheApi ? { 'cache-api': createCacheApiCounterStore() } : {}),
    ...(capabilities.kv ? { kv: createKvCounterStore(env[config.cloudflare.bindings.kv] as never) } : {}),
    ...(input.overrides?.counterStores ?? {}),
  };
  // `auto`: Durable Object (exact, global) → Cache API (per colo) → memory (per isolate). KV is opt-in
  // per policy because its eventual consistency makes it a poor default counter.
  const counterStore = input.overrides?.counterStore ?? counterStores['durable-object'] ?? counterStores['cache-api'] ?? counterStores.memory!;
  const rateLimitBinding = input.overrides?.rateLimitBinding ?? ((capabilities.rateLimitBinding ? (env[config.cloudflare.bindings.rateLimit] as RateLimitBindingLike) : null) ?? null);
  const flagsProvider = input.overrides?.flagsProvider ?? flagsProviderFor(config, env, capabilities);
  const tracer = input.overrides?.tracer !== undefined ? input.overrides.tracer : tracerFor(config, env, capabilities);
  const vitals = config.observe.vitals;
  const vitalsSink = input.overrides?.vitalsSink !== undefined ? input.overrides.vitalsSink : vitals ? (vitals.sink === 'analytics-engine' && capabilities.analyticsEngine ? analyticsEngineVitalsSink(env[vitals.analyticsEngineBinding] as never) : vitals.sink === 'none' ? null : logVitalsSink(log)) : null;
  const turnstile = config.security.bots?.turnstile;
  const turnstileVerify =
    input.overrides?.turnstileVerify ??
    (turnstile
      ? async (token: string, ip: string) => {
          const secret = readEnv(env, turnstile.secretEnv);
          if (!secret) return false;
          return (await verifyTurnstile(secret, token, ip)).success;
        }
      : null);
  const edgeCache = edge
    ? createEdgeCache({
        store: cacheStore,
        tagIndex,
        config,
        manifest,
        log,
        ...(purger ? { purger } : {}),
        // Cache variants use the values the earlier stages computed (flags, negotiated locale).
        resolvers: {
          flags: (ctx) => ctx.state.get(FLAGS_KEY),
          locale: (ctx) => ctx.state.get(LOCALE_KEY)?.locale,
        },
      })
    : null;
  return {
    config,
    manifest,
    matcher: createRouteMatcher(manifest),
    capabilities,
    env,
    runner,
    development,
    log,
    cacheStore,
    tagIndex,
    purger,
    counterStore,
    counterStores,
    rateLimitBinding,
    flagsProvider,
    tracer,
    vitalsSink,
    turnstileVerify,
    edgeCache,
  };
}

/** Builds the default, ordered stage list for a platform (architecture §5). */
export function buildDefaultStages(platform: Platform): Stage[] {
  const { config } = platform;
  const limiter = createRateLimiter({
    store: platform.counterStore,
    stores: platform.counterStores,
    ...(platform.rateLimitBinding ? { binding: platform.rateLimitBinding } : {}),
    // Fail open (availability first) but never silently.
    onError: (error, policy, key) => platform.log.error('rate limit store failed; allowing request', { policy: policy.id, key, error: (error as Error)?.message ?? String(error) }),
  });
  const kv = platform.capabilities.kv ? (platform.env[config.cloudflare.bindings.kv] as never) : undefined;
  const candidates: Array<Stage | null> = [
    requestIdStage(config, platform.tracer ?? undefined),
    maintenanceStage(config, { kv }),
    shieldStage(config),
    botsStage(config, { ...(platform.turnstileVerify ? { turnstileVerify: platform.turnstileVerify } : {}) }),
    config.security.rateLimit.length ? rateLimitStage(config, limiter) : null,
    config.security.csrf ? csrfStage(config) : null,
    geoStage(config),
    i18nStage(config),
    Object.keys(config.flags.definitions).length || config.flags.provider !== 'static' ? flagsStage(config, platform.flagsProvider) : null,
    redirectsStage(config, { kv }),
    config.purser?.theme ? themeStage(config) : null,
    cspStage(config),
    platform.edgeCache ? platform.edgeCache.stage() : null,
    securityHeadersStage(config),
    earlyHintsStage(config),
    speculationStage(config),
    skewStage(config),
    observeStage(config, { ...(platform.tracer ? { tracer: platform.tracer } : {}), ...(platform.vitalsSink ? { vitalsSink: platform.vitalsSink } : {}) }),
  ];
  const stages = candidates.filter((s): s is Stage => s !== null);
  return orderStages(stages, { order: config.stages.order, disable: config.stages.disable });
}

/** Namespace of stage factories for custom pipelines (`createProxy(config, [stages.requestId(), ...])`). */
export const stages = {
  requestId: requestIdStage,
  maintenance: maintenanceStage,
  shield: shieldStage,
  bots: botsStage,
  rateLimit: rateLimitStage,
  csrf: csrfStage,
  geo: geoStage,
  i18n: i18nStage,
  flags: flagsStage,
  redirects: redirectsStage,
  theme: themeStage,
  csp: cspStage,
  securityHeaders: securityHeadersStage,
  earlyHints: earlyHintsStage,
  speculation: speculationStage,
  skew: skewStage,
  observe: observeStage,
  /** Wraps a plain function as a stage. */
  custom(name: string, pre?: Stage['pre'], post?: Stage['post']): Stage {
    return { name, ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
  },
};

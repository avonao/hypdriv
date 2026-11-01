import type { CacheStore, Purger, TagIndex } from '@hypdriv/cache';
import {
  createEdgeCache,
  createMemoryStore,
  createMemoryTagIndex,
  createZonePurger,
  selectStore,
} from '@hypdriv/cache';
import {
  type Capabilities,
  createRouteMatcher,
  type DeployTarget,
  detectCapabilities,
  emptyManifest,
  type HypDrivEnv,
  type HypManifest,
  type Logger,
  orderStages,
  type RateLimitBindingLike,
  type RateLimitStore,
  type ResolvedConfig,
  type RouteMatcher,
  type Runner,
  readEnv,
  type Stage,
} from '@hypdriv/core';
import {
  analyticsEngineExposureSink,
  type ExposureSink,
  envProvider,
  FLAGS_KEY,
  type FlagProvider,
  flagsStage,
  kvProvider,
  logExposureSink,
  staticProvider,
} from '@hypdriv/flags';
import {
  analyticsEngineVitalsSink,
  analyticsEngineVitalsSource,
  cachedVitalsSource,
  createLogger,
  logVitalsSink,
  type MemoryVitals,
  memoryVitals,
  multiVitalsSink,
  observeStage,
  requestIdStage,
  type Tracer,
  type VitalsSink,
  type VitalsSource,
} from '@hypdriv/observe';
import { themeStage } from '@hypdriv/purser';
import {
  botsStage,
  type CounterStore,
  createCacheApiCounterStore,
  createKvCounterStore,
  createMemoryCounterStore,
  createRateLimiter,
  cspStage,
  csrfStage,
  rateLimitStage,
  securityHeadersStage,
  shieldStage,
  verifyTurnstile,
} from '@hypdriv/security';
import { createConfiguredTracer } from '../shared/tracer';
import { devtoolsStage } from './devtools';
import { earlyHintsStage } from './early-hints';
import { geoStage } from './geo';
import { i18nStage, LOCALE_KEY } from './i18n';
import { maintenanceStage } from './maintenance';
import { redirectsStage } from './redirects';
import { skewStage } from './skew';
import { speculationStage } from './speculation';

export { type HintOptions, hasModuleScripts, linkEntriesForRoute, linkHeaderValues } from '../shared/hints';
export {
  buildSpeculationRules,
  componentSpeculationRules,
  type SpeculationRules,
  speculationScript,
  speculationScriptHash,
} from '../shared/speculation';
export { createConfiguredTracer } from '../shared/tracer';
export { devtoolsEnabledFor, devtoolsStage } from './devtools';
export { earlyHintsStage } from './early-hints';
export { edgeStages, htmlTransformsStage, priorityHintsStage } from './edge';
export { decodeGeoHeader, encodeGeoHeader, GEO_KEY, type GeoInfo, geoFrom, geoStage } from './geo';
export { i18nStage, LOCALE_KEY, negotiateLocale, splitLocale } from './i18n';
export { type InternalRoutesOptions, internalRoutes } from './internal-routes';
export { maintenanceStage, renderMaintenancePage } from './maintenance';
export { expandDestination, forcesHttps, httpsUpgrade, matchRedirect, redirectsStage } from './redirects';
export { skewStage } from './skew';
export { SPECULATION_KEY, speculationStage } from './speculation';

/** Everything the stages need from the host runtime (ADR 0004: stores are chosen from capabilities). */
export interface Platform {
  config: ResolvedConfig;
  manifest: HypManifest;
  matcher: RouteMatcher;
  capabilities: Capabilities;
  env: HypDrivEnv;
  runner: Runner;
  /** Where the platform runs (`cloudflare` · `vercel` · `node`); `node` when not given. */
  target: DeployTarget;
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
  /** Where experiment exposures go (`null` when `flags.exposures` is `none`). */
  exposureSink: ExposureSink | null;
  tracer: Tracer | null;
  vitalsSink: VitalsSink | null;
  /** Where the vitals dashboard reads from (`null` when `observe.vitals.dashboard` is off). */
  vitalsSource: VitalsSource | null;
  /** Setup hints for the dashboard, shown on its page (what to configure for durable storage). */
  vitalsSourceNotes: string[];
  turnstileVerify: ((token: string, ip: string) => Promise<boolean>) | null;
  /** Cache engine instance (shared with `purgeEdge`). */
  edgeCache: ReturnType<typeof createEdgeCache> | null;
}

export interface CreatePlatformInput {
  config: ResolvedConfig;
  manifest: HypManifest | null;
  env: HypDrivEnv;
  runner: Runner;
  /** Deploy target (default: `cloudflare` for the Worker runner, else `node`). */
  target?: DeployTarget;
  development?: boolean;
  log?: Logger;
  /** Overrides for tests and the Worker shell (Durable Object stores etc.). */
  overrides?: Partial<
    Pick<
      Platform,
      | 'cacheStore'
      | 'tagIndex'
      | 'purger'
      | 'counterStore'
      | 'counterStores'
      | 'rateLimitBinding'
      | 'flagsProvider'
      | 'exposureSink'
      | 'tracer'
      | 'vitalsSink'
      | 'vitalsSource'
      | 'turnstileVerify'
      | 'capabilities'
    >
  >;
}

/** `flags.exposures`: Analytics Engine when asked for (or `auto` and bound), the log otherwise. */
function exposureSinkFor(config: ResolvedConfig, env: HypDrivEnv, log: Logger): ExposureSink | null {
  const f = config.flags;
  if (f.exposures === 'none') return null;
  const binding = env[f.exposuresBinding];
  const bound = typeof (binding as { writeDataPoint?: unknown } | undefined)?.writeDataPoint === 'function';
  if (f.exposures === 'analytics-engine' || (f.exposures === 'auto' && bound)) {
    if (bound) return analyticsEngineExposureSink(binding as never);
    log.warn('flags.exposures is analytics-engine but the binding is missing; exposures go to the log', {
      binding: f.exposuresBinding,
    });
  }
  return logExposureSink(log);
}

function flagsProviderFor(config: ResolvedConfig, env: HypDrivEnv, caps: Capabilities): FlagProvider {
  const f = config.flags;
  if (f.provider === 'env') return envProvider(env, f.envVar, f.definitions);
  if (f.provider === 'kv' && caps.kv)
    return kvProvider(env[f.kvBinding] as never, f.kvKey, f.definitions, f.refreshSeconds);
  return staticProvider(f.definitions);
}

/**
 * Picks where the vitals dashboard reads from: Workers Analytics Engine through its SQL API when the account
 * id, a read-only API token and the dataset name are all available, else a ring buffer of the measurements
 * this instance receives. `notes` says what is missing for the durable option.
 */
function createVitalsDashboardSource(
  config: ResolvedConfig,
  env: HypDrivEnv,
  log: Logger,
  override: VitalsSource | null | undefined,
): { source: VitalsSource | null; memory: MemoryVitals | null; notes: string[] } {
  const vitals = config.observe.vitals;
  const dashboard = vitals?.dashboard;
  if (override !== undefined) return { source: override, memory: null, notes: [] };
  if (!vitals || !dashboard) return { source: null, memory: null, notes: [] };
  const accountId = readEnv(env, dashboard.accountIdEnv);
  const apiToken = readEnv(env, dashboard.apiTokenEnv);
  const dataset = dashboard.dataset ?? readEnv(env, dashboard.datasetEnv);
  if (accountId && apiToken && dataset) {
    try {
      const notes =
        vitals.sink === 'analytics-engine'
          ? []
          : [
              "`observe.vitals.sink` is not 'analytics-engine', so no measurements reach the dataset this page reads. Set it to `analytics-engine` and bind `HYPDRIV_ANALYTICS`.",
            ];
      return {
        source: cachedVitalsSource(analyticsEngineVitalsSource({ accountId, apiToken, dataset }), {
          ttlSeconds: dashboard.cacheSeconds,
        }),
        memory: null,
        notes,
      };
    } catch (err) {
      log.warn('vitals dashboard: Analytics Engine source unavailable', { error: (err as Error).message });
    }
  }
  const missing = [
    !accountId ? `\`${dashboard.accountIdEnv}\`` : null,
    !apiToken ? `\`${dashboard.apiTokenEnv}\` (Account Analytics: Read)` : null,
    !dataset ? `\`${dashboard.datasetEnv}\` or \`observe.vitals.dashboard.dataset\`` : null,
  ].filter((m): m is string => m !== null);
  const notes = [
    `For durable, site-wide numbers set ${missing.join(', ')}, and use \`observe.vitals.sink: 'analytics-engine'\` so the dataset receives the measurements.`,
  ];
  if (dashboard.memoryCapacity <= 0) return { source: null, memory: null, notes };
  const memory = memoryVitals({ capacity: dashboard.memoryCapacity, sampleRate: vitals.sampleRate });
  return { source: memory.source, memory, notes };
}

/** Assembles the platform: capabilities, stores, providers and the route matcher. */
export function createPlatform(input: CreatePlatformInput): Platform {
  const { config, env, runner } = input;
  const target: DeployTarget = input.target ?? (runner === 'worker' ? 'cloudflare' : 'node');
  const manifest = input.manifest ?? emptyManifest();
  const development = input.development ?? false;
  const log = input.log ?? createLogger(config.observe.logging, { service: config.site.name, runner });
  const capabilities =
    input.overrides?.capabilities ??
    detectCapabilities(env as Record<string, unknown>, config, {
      cf: runner === 'worker' || target === 'cloudflare',
      waitUntil: runner !== 'node',
    });
  const edge = config.cache.edge;
  const cacheStore =
    input.overrides?.cacheStore ??
    (edge ? selectStore(edge.store, capabilities, env, config) : createMemoryStore());
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
  const counterStore =
    input.overrides?.counterStore ??
    counterStores['durable-object'] ??
    counterStores['cache-api'] ??
    counterStores.memory!;
  const rateLimitBinding =
    input.overrides?.rateLimitBinding ??
    (capabilities.rateLimitBinding
      ? (env[config.cloudflare.bindings.rateLimit] as RateLimitBindingLike)
      : null) ??
    null;
  const flagsProvider = input.overrides?.flagsProvider ?? flagsProviderFor(config, env, capabilities);
  const exposureSink =
    input.overrides?.exposureSink !== undefined
      ? input.overrides.exposureSink
      : exposureSinkFor(config, env, log);
  const tracer =
    input.overrides?.tracer !== undefined
      ? input.overrides.tracer
      : createConfiguredTracer(config, env, capabilities);
  const vitals = config.observe.vitals;
  const configuredVitalsSink =
    input.overrides?.vitalsSink !== undefined
      ? input.overrides.vitalsSink
      : vitals
        ? vitals.sink === 'analytics-engine' && capabilities.analyticsEngine
          ? analyticsEngineVitalsSink(env[vitals.analyticsEngineBinding] as never)
          : vitals.sink === 'none'
            ? null
            : logVitalsSink(log)
        : null;
  const dashboard = createVitalsDashboardSource(config, env, log, input.overrides?.vitalsSource);
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
    matcher: createRouteMatcher(manifest, {
      onInvalidRoute: (route, error) =>
        log.error('route skipped: its pattern cannot be compiled to a matcher', {
          route: route.id,
          pathname: route.pathname,
          error: error.message,
        }),
    }),
    capabilities,
    env,
    runner,
    target,
    development,
    log,
    cacheStore,
    tagIndex,
    purger,
    counterStore,
    counterStores,
    rateLimitBinding,
    flagsProvider,
    exposureSink,
    tracer,
    // The dashboard's in-memory fallback is fed next to the configured sink.
    vitalsSink: dashboard.memory
      ? multiVitalsSink(
          configuredVitalsSink ? [configuredVitalsSink, dashboard.memory.sink] : [dashboard.memory.sink],
        )
      : configuredVitalsSink,
    vitalsSource: dashboard.source,
    vitalsSourceNotes: dashboard.notes,
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
    onError: (error, policy, key) =>
      platform.log.error('rate limit store failed; allowing request', {
        policy: policy.id,
        key,
        error: (error as Error)?.message ?? String(error),
      }),
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
    Object.keys(config.flags.definitions).length || config.flags.provider !== 'static'
      ? flagsStage(config, platform.flagsProvider, {
          ...(platform.exposureSink ? { onExposure: platform.exposureSink } : {}),
        })
      : null,
    redirectsStage(config, { kv, target: platform.target }),
    config.purser?.theme ? themeStage(config) : null,
    // Runners that own the response body inject nonces even without `HTMLRewriter` (framework hooks on Node
    // and Vercel Functions); `proxy.ts` only sees Next's pass-through marker.
    cspStage(config, { portableInjection: platform.runner === 'host' }),
    platform.edgeCache ? platform.edgeCache.stage() : null,
    securityHeadersStage(config),
    earlyHintsStage(config),
    speculationStage(config),
    skewStage(config),
    devtoolsStage(config),
    observeStage(config, {
      ...(platform.tracer ? { tracer: platform.tracer } : {}),
      ...(platform.vitalsSink ? { vitalsSink: platform.vitalsSink } : {}),
    }),
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
  devtools: devtoolsStage,
  observe: observeStage,
  /** Wraps a plain function as a stage. */
  custom(name: string, pre?: Stage['pre'], post?: Stage['post']): Stage {
    return { name, ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
  },
};

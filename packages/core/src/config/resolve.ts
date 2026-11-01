import { parseDuration, parseDurationMs, parseSize } from '../util/units';
import {
  COOKIE,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_CACHEABLE_STATUSES,
  DEFAULT_HONEYPOTS,
  DEFAULT_PERMISSIONS_POLICY,
  DEFAULT_SECRET_PATTERNS,
  DEFAULT_SHIELD_METHODS,
  DEFAULT_SPECULATION_EXCLUDE,
  DEFAULT_TRACKING_PARAMS,
  HEADER,
  INTERNAL_PATH_PREFIX,
} from './defaults';
import type {
  ResolvedBots,
  ResolvedCache,
  ResolvedConfig,
  ResolvedCsp,
  ResolvedEdgeCachePolicy,
  ResolvedPerformance,
  ResolvedPurser,
  ResolvedRateLimitPolicy,
  ResolvedSecurity,
  ResolvedSecurityHeaders,
  ResolvedShield,
  ResolvedSpeculation,
} from './resolved';
import type {
  CspConfig,
  EdgeCachePolicy,
  HypDrivConfig,
  RateLimitPolicy,
  SecurityHeadersConfig,
} from './types';

function obj<T extends object>(value: boolean | T | undefined, defaultEnabled: boolean): T | null {
  if (value === false) return null;
  if (value === true || value === undefined) return defaultEnabled || value === true ? ({} as T) : null;
  return value;
}

function arr<T>(value: T[] | undefined, fallback: T[]): T[] {
  return value ? [...value] : [...fallback];
}

const STRICT_CSP_BASE: ResolvedCsp['directives'] = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'self'"],
  'form-action': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'media-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'frame-src': ["'self'"],
};

function resolveCsp(input: boolean | CspConfig | undefined): ResolvedCsp | null {
  const c = obj<CspConfig>(input, true);
  if (!c) return null;
  const tt = c.trustedTypes;
  return {
    mode: c.mode ?? 'auto',
    reportOnly: c.reportOnly ?? false,
    directives: { ...STRICT_CSP_BASE, ...(c.directives ?? {}) },
    allow: {
      scripts: arr(c.allow?.scripts, []),
      styles: arr(c.allow?.styles, []),
      images: arr(c.allow?.images, []),
      fonts: arr(c.allow?.fonts, []),
      connect: arr(c.allow?.connect, []),
      frames: arr(c.allow?.frames, []),
      media: arr(c.allow?.media, []),
      workers: arr(c.allow?.workers, []),
      frameAncestors: arr(c.allow?.frameAncestors, []),
      formAction: arr(c.allow?.formAction, []),
    },
    routes: (c.routes ?? []).map((r) => ({
      match: r.match,
      directives: r.directives ?? {},
      ...(r.mode ? { mode: r.mode } : {}),
      ...(r.reportOnly !== undefined ? { reportOnly: r.reportOnly } : {}),
    })),
    strictDynamic: c.strictDynamic ?? true,
    unsafeInlineStyles: c.unsafeInlineStyles ?? true,
    devUnsafeEval: c.devUnsafeEval ?? true,
    reportTo: c.reportTo === false ? null : (c.reportTo ?? `${INTERNAL_PATH_PREFIX}/csp-report`),
    reportingEndpoints: c.reportingEndpoints ?? true,
    trustedTypes: !tt
      ? null
      : tt === true
        ? { policies: ['nextjs', 'react', 'hypdriv'], allowDuplicates: true }
        : { policies: tt.policies, allowDuplicates: tt.allowDuplicates ?? true },
    upgradeInsecureRequests: c.upgradeInsecureRequests ?? true,
    nonceHeader: c.nonceHeader ?? HEADER.nonce,
  };
}

function resolveHeaders(input: boolean | SecurityHeadersConfig | undefined): ResolvedSecurityHeaders | null {
  const h = obj<SecurityHeadersConfig>(input, true);
  if (!h) return null;
  return {
    hsts:
      h.hsts === false
        ? null
        : {
            maxAge: parseDuration(h.hsts?.maxAge, 63072000),
            includeSubDomains: h.hsts?.includeSubDomains ?? true,
            preload: h.hsts?.preload ?? false,
          },
    coop: h.coop === false ? null : (h.coop ?? 'same-origin-allow-popups'),
    corp: h.corp === false ? null : (h.corp ?? 'same-site'),
    coep: h.coep === false || h.coep === undefined ? null : h.coep,
    referrerPolicy:
      h.referrerPolicy === false ? null : (h.referrerPolicy ?? 'strict-origin-when-cross-origin'),
    permissionsPolicy:
      h.permissionsPolicy === false
        ? null
        : Object.fromEntries(
            Object.entries({ ...DEFAULT_PERMISSIONS_POLICY, ...(h.permissionsPolicy ?? {}) }).map(
              ([k, v]) => [k, [...v]],
            ),
          ),
    frameOptions: h.frameOptions === false ? null : (h.frameOptions ?? 'DENY'),
    noSniff: h.noSniff ?? true,
    dnsPrefetchControl: h.dnsPrefetchControl === false ? null : (h.dnsPrefetchControl ?? 'on'),
    permittedCrossDomainPolicies:
      h.permittedCrossDomainPolicies === false ? null : (h.permittedCrossDomainPolicies ?? 'none'),
    originAgentCluster: h.originAgentCluster ?? true,
    stripFingerprints: h.stripFingerprints ?? true,
    extra: { ...(h.extra ?? {}) },
    routes: [...(h.routes ?? [])],
  };
}

function resolveRateLimit(policies: RateLimitPolicy[] | undefined): ResolvedRateLimitPolicy[] {
  return (policies ?? []).map((p) => {
    const keys = Array.isArray(p.key) ? p.key : [p.key ?? 'ip'];
    return {
      id: p.id,
      match: p.match,
      methods: p.methods ?? [],
      limit: p.limit,
      windowSeconds: parseDuration(p.window, 60),
      burst: p.burst ?? 0,
      algorithm: p.algorithm ?? 'sliding-window',
      keys,
      store: p.store ?? 'auto',
      apiKeyHeader: p.apiKeyHeader ?? 'authorization',
      sessionCookie: p.sessionCookie ?? COOKIE.session,
      userHeader: p.userHeader ?? HEADER.userId,
      response: {
        status: p.response?.status ?? 429,
        body: p.response?.body ?? { error: 'rate_limited', policy: p.id },
        headers: { ...(p.response?.headers ?? {}) },
      },
      headers: p.headers ?? true,
      skip: p.skip ?? null,
    };
  });
}

function resolveBots(input: import('./types').SecurityConfig['bots']): ResolvedBots | null {
  const b = obj<NonNullable<Exclude<typeof input, boolean>>>(input, true);
  if (!b) return null;
  return {
    verified: b.verified ?? 'allow',
    likelyAutomated: b.likelyAutomated ?? 'log',
    definitelyAutomated: b.definitelyAutomated ?? 'block',
    scoreThreshold: b.scoreThreshold ?? 30,
    honeypots: arr(b.honeypots, DEFAULT_HONEYPOTS),
    blockUserAgents: arr(b.blockUserAgents, []),
    allowUserAgents: arr(b.allowUserAgents, []),
    exempt: b.exempt ?? ['/_next/**', `${INTERNAL_PATH_PREFIX}/**`, '/api/webhooks/**'],
    secFetchChecks: b.secFetchChecks ?? true,
    turnstile: b.turnstile
      ? {
          siteKey: b.turnstile.siteKey ?? null,
          siteKeyEnv: b.turnstile.siteKeyEnv ?? (b.turnstile.siteKey ? null : 'TURNSTILE_SITE_KEY'),
          secretEnv: b.turnstile.secretEnv ?? 'TURNSTILE_SECRET_KEY',
          action: b.turnstile.action ?? null,
        }
      : null,
    tarpitMs: Math.min(Math.max(b.tarpitMs ?? 3000, 0), 10000),
  };
}

function resolveShield(input: import('./types').SecurityConfig['shield']): ResolvedShield | null {
  const s = obj<NonNullable<Exclude<typeof input, boolean>>>(input, true);
  if (!s) return null;
  const maxBody =
    s.maxBody === undefined
      ? [
          { match: '/api/**', limit: parseSize('1mb', 0) },
          { match: '/**', limit: parseSize('10mb', 0) },
        ]
      : Array.isArray(s.maxBody)
        ? s.maxBody.map((m) => ({ match: m.match, limit: parseSize(m.limit, 0) }))
        : [{ match: '/**', limit: parseSize(s.maxBody, 0) }];
  return {
    methods: arr(s.methods, DEFAULT_SHIELD_METHODS).map((m) => m.toUpperCase()),
    maxBody,
    maxUrlLength: s.maxUrlLength ?? 8192,
    blockTraversal: s.blockTraversal ?? true,
    blockedPaths: arr(s.blockedPaths, DEFAULT_BLOCKED_PATHS),
    enforceHost: s.enforceHost === true ? [] : s.enforceHost ? [...s.enforceHost] : null,
  };
}

function resolveSecurity(input: HypDrivConfig['security']): ResolvedSecurity {
  const s = input ?? {};
  const scan = obj<NonNullable<Exclude<typeof s.secretsScan, boolean>>>(s.secretsScan, true);
  const csrf = obj<NonNullable<Exclude<typeof s.csrf, boolean>>>(s.csrf, false);
  return {
    headers: resolveHeaders(s.headers),
    csp: resolveCsp(s.csp),
    rateLimit: resolveRateLimit(s.rateLimit),
    bots: resolveBots(s.bots),
    shield: resolveShield(s.shield),
    csrf: csrf
      ? {
          cookie: csrf.cookie ?? COOKIE.csrf,
          header: csrf.header ?? 'x-csrf-token',
          match: csrf.match ?? '/api/**',
          exempt: csrf.exempt ?? ['/api/webhooks/**', `${INTERNAL_PATH_PREFIX}/**`],
          acceptSecFetchSite: csrf.acceptSecFetchSite ?? true,
        }
      : null,
    secretsScan: scan
      ? {
          patterns: [
            ...DEFAULT_SECRET_PATTERNS,
            ...(scan.patterns ?? []).map((p) => ({
              id: p.id,
              pattern: typeof p.pattern === 'string' ? new RegExp(p.pattern) : p.pattern,
              severity: p.severity ?? 'error',
            })),
          ].filter((p) => !(scan.ignore ?? []).includes(p.id)),
          ignore: arr(scan.ignore, []),
          envAllowlist: arr(scan.envAllowlist, []),
          publicPrefixes: arr(scan.publicPrefixes, ['NEXT_PUBLIC_']),
          minValueLength: scan.minValueLength ?? 12,
          failOnFinding: scan.failOnFinding ?? true,
        }
      : null,
    sri: s.sri === true ? { algorithm: 'sha256' } : s.sri ? { algorithm: s.sri.algorithm } : null,
    sessions: {
      cookie: s.sessions?.cookie ?? COOKIE.session,
      secretEnv: s.sessions?.secretEnv ?? 'HYPDRIV_SESSION_SECRET',
      previousSecretEnvs: arr(s.sessions?.previousSecretEnvs, []),
      ttlSeconds: parseDuration(s.sessions?.ttl, 7 * 86400),
      sliding: s.sessions?.sliding ?? true,
      sameSite: s.sessions?.sameSite ?? 'lax',
      secure: s.sessions?.secure ?? true,
      path: s.sessions?.path ?? '/',
      domain: s.sessions?.domain ?? null,
    },
    internalAuth: {
      secretEnv: s.internalAuth?.secretEnv ?? 'HYPDRIV_INTERNAL_SECRET',
      ttlSeconds: parseDuration(s.internalAuth?.ttl, 300),
      header: s.internalAuth?.header ?? HEADER.internalSignature,
    },
    trustedProxies: s.trustedProxies ?? 0,
  };
}

const unique = (...lists: string[][]): string[] => [...new Set(lists.flat())];

export function resolveEdgeCachePolicy(
  p: EdgeCachePolicy,
  index: number,
  source: 'explicit' | 'inferred' = 'explicit',
  shared?: { cookies: string[]; headers: string[]; query: string[] },
): ResolvedEdgeCachePolicy {
  return {
    id: p.id ?? `policy-${index}`,
    match: p.match,
    methods: p.methods ?? ['GET', 'HEAD'],
    ttl: parseDuration(p.ttl, 0),
    swr: parseDuration(p.swr, 0),
    staleIfError: parseDuration(p.staleIfError, 0),
    tags: arr(p.tags, []),
    vary: {
      headers: arr(p.vary?.headers, []).map((h) => h.toLowerCase()),
      cookies: arr(p.vary?.cookies, []),
      geo: arr(p.vary?.geo, []),
      flags: arr(p.vary?.flags, []),
      language: p.vary?.language ?? false,
      device: p.vary?.device ?? false,
    },
    bypass: {
      cookies: unique(arr(p.bypass?.cookies, []), shared?.cookies ?? []),
      headers: unique(
        arr(p.bypass?.headers, []).map((h) => h.toLowerCase()),
        shared?.headers ?? [],
      ),
      query: unique(arr(p.bypass?.query, []), shared?.query ?? []),
      when: p.bypass?.when ?? null,
    },
    respectOrigin: p.respectOrigin ?? true,
    includeRsc: p.includeRsc ?? true,
    statuses: arr(p.statuses, DEFAULT_CACHEABLE_STATUSES),
    keyQuery: p.keyQuery ?? 'all',
    source,
  };
}

function resolveCache(input: HypDrivConfig['cache']): ResolvedCache {
  const c = input ?? {};
  const edge = c.edge === false ? null : c.edge === true || c.edge === undefined ? {} : c.edge;
  const sharedBypass = {
    cookies: arr(edge?.bypass?.cookies, []),
    headers: arr(edge?.bypass?.headers, []).map((h) => h.toLowerCase()),
    query: arr(edge?.bypass?.query, []),
  };
  return {
    edge: edge
      ? {
          policies: (edge.policies ?? []).map((p, i) =>
            resolveEdgeCachePolicy(p, i, 'explicit', sharedBypass),
          ),
          bypass: sharedBypass,
          infer: edge.infer ?? true,
          inferredStatic: {
            ttl: parseDuration(edge.inferredStatic?.ttl, 300),
            swr: parseDuration(edge.inferredStatic?.swr, 86400),
            staleIfError: parseDuration(edge.inferredStatic?.staleIfError, 7 * 86400),
          },
          inferredShell:
            edge.inferredShell === false || edge.inferredShell === undefined
              ? null
              : {
                  ttl: parseDuration(edge.inferredShell.ttl, 60),
                  swr: parseDuration(edge.inferredShell.swr, 600),
                },
          store: edge.store ?? 'auto',
          memoryTtl: parseDuration(edge.memoryTtl, 10),
          negativeTtl: parseDuration(edge.negativeTtl, 60),
          ignoredQuery: arr(edge.ignoredQuery, DEFAULT_TRACKING_PARAMS),
          maxBodySize: parseSize(edge.maxBodySize, 5 * 1000 * 1000),
          purge: {
            zoneIdEnv: edge.purge?.zoneIdEnv ?? 'CACHE_PURGE_ZONE_ID',
            tokenEnv: edge.purge?.tokenEnv ?? 'CACHE_PURGE_API_TOKEN',
            index: edge.purge?.index ?? 'auto',
          },
          emitTagHeaders: edge.emitTagHeaders ?? true,
          debugHeader: edge.debugHeader ?? true,
        }
      : null,
    warm: {
      routes: arr(c.warm?.routes, []),
      onDeploy: c.warm?.onDeploy ?? false,
      cron: c.warm?.cron ?? null,
      concurrency: c.warm?.concurrency ?? 4,
    },
  };
}

function resolveSpeculation(
  input: import('./types').PerformanceConfig['speculation'],
): ResolvedSpeculation | null {
  const s = obj<NonNullable<Exclude<typeof input, boolean>>>(input, true);
  if (!s) return null;
  return {
    prerender:
      s.prerender === false
        ? null
        : {
            eagerness: s.prerender?.eagerness ?? 'moderate',
            include: arr(s.prerender?.include, ['/*']),
            exclude: arr(s.prerender?.exclude, []),
            topN: s.prerender?.topN ?? 5,
          },
    prefetch:
      s.prefetch === false
        ? null
        : {
            eagerness: s.prefetch?.eagerness ?? 'moderate',
            include: arr(s.prefetch?.include, ['/*']),
            exclude: arr(s.prefetch?.exclude, []),
          },
    exclude: arr(s.exclude, DEFAULT_SPECULATION_EXCLUDE),
    useGraph: s.useGraph ?? true,
    inject: s.inject ?? 'auto',
  };
}

function resolvePerformance(input: HypDrivConfig['performance']): ResolvedPerformance {
  const p = input ?? {};
  const eh = obj<NonNullable<Exclude<typeof p.earlyHints, boolean>>>(p.earlyHints, true);
  const skew =
    p.skewProtection === false
      ? null
      : p.skewProtection === true || p.skewProtection === undefined
        ? {}
        : p.skewProtection;
  const cb = p.fetch?.circuitBreaker;
  return {
    earlyHints: eh
      ? {
          preconnect: arr(eh.preconnect, []),
          fonts: eh.fonts ?? true,
          styles: eh.styles ?? true,
          scripts: eh.scripts ?? 'main',
          purser: eh.purser ?? true,
          maxLinks: eh.maxLinks ?? 12,
          onRsc: eh.onRsc ?? false,
        }
      : null,
    speculation: resolveSpeculation(p.speculation),
    priorityHints: p.priorityHints ? { selectors: [...p.priorityHints.selectors] } : null,
    skewProtection: skew
      ? { deploymentId: skew.deploymentId ?? null, reloadOnMismatch: skew.reloadOnMismatch ?? true }
      : null,
    fetch: {
      timeoutMs: parseDurationMs(p.fetch?.timeout, 10000),
      retries: p.fetch?.retries ?? 2,
      retryOn: arr(p.fetch?.retryOn, [408, 425, 429, 500, 502, 503, 504]),
      backoff: {
        baseMs: p.fetch?.backoff?.baseMs ?? 100,
        maxMs: p.fetch?.backoff?.maxMs ?? 2000,
        jitter: p.fetch?.backoff?.jitter ?? true,
      },
      circuitBreaker:
        cb === false
          ? null
          : {
              failureThreshold: cb?.failureThreshold ?? 5,
              cooldownMs: parseDurationMs(cb?.cooldown, 30000),
              halfOpenMax: cb?.halfOpenMax ?? 1,
            },
    },
    html: {
      stripComments: p.html?.stripComments ?? false,
      collapseWhitespace: p.html?.collapseWhitespace ?? false,
    },
  };
}

function resolveObserve(input: HypDrivConfig['observe'], siteName: string): ResolvedConfig['observe'] {
  const o = input ?? {};
  const tracing = obj<NonNullable<Exclude<typeof o.tracing, boolean>>>(o.tracing, true);
  const vitals = obj<NonNullable<Exclude<typeof o.vitals, boolean>>>(o.vitals, true);
  const dashboard = vitals
    ? obj<NonNullable<Exclude<typeof vitals.dashboard, boolean>>>(vitals.dashboard, false)
    : null;
  return {
    tracing: tracing
      ? {
          exporter: tracing.exporter ?? 'console',
          serviceName: tracing.serviceName ?? siteName,
          sampleRate: tracing.sampleRate ?? 1,
          otlp: tracing.otlp
            ? {
                url: tracing.otlp.url,
                headers: { ...(tracing.otlp.headers ?? {}) },
                headersEnv: tracing.otlp.headersEnv ?? null,
                timeoutMs: parseDurationMs(tracing.otlp.timeout, 5000),
              }
            : null,
          analyticsEngineBinding: tracing.analyticsEngineBinding ?? 'HYPDRIV_ANALYTICS',
          propagate: tracing.propagate ?? true,
        }
      : null,
    logging: {
      level: o.logging?.level ?? 'info',
      format: o.logging?.format ?? 'json',
      redact: arr(o.logging?.redact, []),
      sampleRate: o.logging?.sampleRate ?? 1,
      requests: o.logging?.requests ?? true,
    },
    serverTiming:
      o.serverTiming === false
        ? 'off'
        : o.serverTiming === true || o.serverTiming === undefined
          ? 'auto'
          : o.serverTiming,
    vitals: vitals
      ? {
          endpoint: vitals.endpoint ?? `${INTERNAL_PATH_PREFIX}/vitals`,
          sampleRate: vitals.sampleRate ?? 1,
          sink: vitals.sink ?? 'log',
          analyticsEngineBinding: vitals.analyticsEngineBinding ?? 'HYPDRIV_ANALYTICS',
          attribution: vitals.attribution ?? true,
          dashboard: dashboard
            ? {
                tokenEnv: dashboard.tokenEnv ?? 'HYPDRIV_DASH_TOKEN',
                accountIdEnv: dashboard.accountIdEnv ?? 'HYPDRIV_ANALYTICS_ACCOUNT_ID',
                apiTokenEnv: dashboard.apiTokenEnv ?? 'HYPDRIV_ANALYTICS_API_TOKEN',
                dataset: dashboard.dataset ?? null,
                datasetEnv: dashboard.datasetEnv ?? 'HYPDRIV_ANALYTICS_DATASET',
                days: dashboard.days ?? 7,
                cacheSeconds: dashboard.cacheSeconds ?? 60,
                sessionMinutes: dashboard.sessionMinutes ?? 480,
                memoryCapacity: dashboard.memoryCapacity ?? 5000,
              }
            : null,
        }
      : null,
    errors: { sink: o.errors?.sink ?? 'log', includeStack: o.errors?.includeStack ?? true },
  };
}

function resolvePurser(input: HypDrivConfig['purser']): ResolvedPurser | null {
  if (input === false) return null;
  const p = input ?? {};
  const theme = p.theme;
  return {
    enabled: p.enabled ?? 'auto',
    project: p.project ?? '.',
    src: arr(p.src, ['app', 'components', 'lib']),
    tokens: p.tokens ?? null,
    out: p.out ?? 'app/purser.css',
    prefix: p.prefix ?? 'x',
    salt: p.salt ?? '',
    packageName: p.packageName ?? '@avonao/purser',
    cssModule: p.cssModule ?? null,
    layers: {
      tokens: p.layers?.tokens ?? 'purser.tokens',
      globals: p.layers?.globals ?? 'purser.globals',
      atoms: p.layers?.atoms ?? 'purser.atoms',
    },
    verify: p.verify ?? 'error',
    usageReport: p.usageReport ?? true,
    theme: theme
      ? {
          cookie: theme.cookie ?? COOKIE.theme,
          axes: Object.fromEntries(
            Object.entries(theme.axes).map(([name, axis]) => [
              name,
              {
                cookie: axis.cookie ?? name,
                classes: { ...axis.classes },
                default: axis.default,
                clientHint: axis.clientHint ?? null,
              },
            ]),
          ),
          fallbackScript: theme.fallbackScript ?? true,
          acceptClientHints: theme.acceptClientHints ?? true,
        }
      : null,
    audit: {
      widths: arr(p.audit?.widths, [360, 768, 1280]),
      states: arr(p.audit?.states, ['default', 'hover', 'focus']),
      routes: p.audit?.routes ? [...p.audit.routes] : null,
    },
    earlyHints: p.earlyHints ?? true,
    checkInDoctor: p.checkInDoctor ?? true,
  };
}

/** Applies every documented default. Pure; safe to call at module scope in a Worker. */
const RESOLVED_BRAND = Symbol.for('hypdriv.resolved-config');

/**
 * `true` for configs produced by `resolveConfig` / `loadConfig` (branded with a non-enumerable symbol), so APIs
 * that accept both `hypdriv.config` input and resolved configs never mistake one for the other.
 */
export function isResolvedConfig(value: unknown): value is ResolvedConfig {
  return !!value && typeof value === 'object' && (value as Record<symbol, unknown>)[RESOLVED_BRAND] === true;
}

export function resolveConfig(input: HypDrivConfig = {}): ResolvedConfig {
  const resolved = resolveConfigShape(input);
  Object.defineProperty(resolved, RESOLVED_BRAND, { value: true, enumerable: false });
  return resolved;
}

function resolveConfigShape(input: HypDrivConfig): ResolvedConfig {
  const siteName = input.site?.name ?? 'app';
  const devtools =
    input.devtools === false
      ? { enabled: false as const }
      : input.devtools === true || input.devtools === undefined
        ? {}
        : input.devtools;
  const live = input.live ?? {};
  const images = input.images ?? {};
  const jobs = input.jobs ?? {};
  const budgets = input.budgets ?? {};
  const cf = input.cloudflare ?? {};
  const vc = input.vercel ?? {};
  const redirects = input.redirects ?? {};
  const maintenance = input.maintenance ?? {};
  const flags = input.flags ?? {};
  const i18n = input.i18n;

  const sizeOrNull = (v: import('./types').Size | undefined) => (v === undefined ? null : parseSize(v, 0));

  return {
    site: {
      name: siteName,
      origin: input.site?.origin ?? null,
      basePath: input.site?.basePath ?? null,
      trailingSlash: input.site?.trailingSlash ?? null,
    },
    security: resolveSecurity(input.security),
    cache: resolveCache(input.cache),
    performance: resolvePerformance(input.performance),
    observe: resolveObserve(input.observe, siteName),
    purser: resolvePurser(input.purser),
    flags: {
      definitions: { ...(flags.definitions ?? {}) },
      provider: flags.provider ?? 'static',
      envVar: flags.envVar ?? 'HYPDRIV_FLAGS',
      kvBinding: flags.kvBinding ?? 'HYPDRIV_KV',
      kvKey: flags.kvKey ?? 'flags',
      idCookie: flags.idCookie ?? COOKIE.flagsId,
      header: flags.header ?? HEADER.flags,
      queryOverrides: flags.queryOverrides ?? 'development',
      refreshSeconds: parseDuration(flags.refresh, 30),
    },
    live: {
      enabled: live.enabled ?? true,
      binding: live.binding ?? 'HYPDRIV_CHANNEL',
      transport: live.transport ?? 'auto',
      pollIntervalMs: parseDurationMs(live.pollInterval, 5000),
      path: live.path ?? `${INTERNAL_PATH_PREFIX}/live`,
      maxSubscribers: live.maxSubscribers ?? 10000,
      retain: live.retain ?? 50,
      authorize: live.authorize ?? null,
    },
    images: {
      loader: images.loader ?? 'auto',
      cdnCgi: images.cdnCgi ?? 'auto',
      quality: images.quality ?? 75,
      formats: arr(images.formats, ['auto']),
      placeholders: {
        enabled: images.placeholders?.enabled ?? true,
        file: images.placeholders?.file ?? '.hypdriv/placeholders.json',
        size: images.placeholders?.size ?? 16,
        sources: arr(images.placeholders?.sources, ['public']),
      },
      allowedHosts: arr(images.allowedHosts, []),
    },
    jobs: {
      cron: Object.fromEntries(
        Object.entries(jobs.cron ?? {}).map(([name, j]) => [
          name,
          {
            cron: j.cron,
            path: j.path,
            timeoutMs: parseDurationMs(j.timeout, 25000),
            method: j.method ?? 'POST',
          },
        ]),
      ),
      queues: Object.fromEntries(
        Object.entries(jobs.queues ?? {}).map(([name, q]) => [
          name,
          {
            path: q.path,
            retry: q.retry ?? 'failed',
            maxConcurrency: q.maxConcurrency ?? 4,
            queues: q.queues?.length ? [...q.queues] : [name],
          },
        ]),
      ),
      email: jobs.email ? { path: jobs.email.path } : null,
      basePath: jobs.basePath ?? '/api/jobs',
    },
    budgets: {
      routes: Object.fromEntries(
        Object.entries(budgets.routes ?? {}).map(([pattern, b]) => [
          pattern,
          { js: sizeOrNull(b.js), css: sizeOrNull(b.css), html: sizeOrNull(b.html) },
        ]),
      ),
      worker: {
        raw: sizeOrNull(budgets.worker?.raw),
        gzip: sizeOrNull(budgets.worker?.gzip),
        startupMs: budgets.worker?.startupMs ?? null,
      },
      totalJs: sizeOrNull(budgets.totalJs),
      failOn: budgets.failOn ?? 'warn',
      snapshotDir: budgets.snapshotDir ?? '.hypdriv/snapshots',
    },
    cloudflare: {
      bindings: {
        kv: cf.bindings?.kv ?? 'HYPDRIV_KV',
        tagIndex: cf.bindings?.tagIndex ?? 'HYPDRIV_INDEX',
        limiter: cf.bindings?.limiter ?? 'HYPDRIV_LIMITER',
        channel: cf.bindings?.channel ?? 'HYPDRIV_CHANNEL',
        rateLimit: cf.bindings?.rateLimit ?? 'HYPDRIV_RATE_LIMIT',
        analyticsEngine: cf.bindings?.analyticsEngine ?? 'HYPDRIV_ANALYTICS',
        images: cf.bindings?.images ?? 'IMAGES',
        assets: cf.bindings?.assets ?? 'ASSETS',
        queues: { ...(cf.bindings?.queues ?? {}) },
        ai: cf.bindings?.ai ?? 'AI',
      },
      smartPlacement: cf.smartPlacement ?? false,
      runWorkerFirst: cf.runWorkerFirst ?? false,
      internalPathPrefix: cf.internalPathPrefix ?? INTERNAL_PATH_PREFIX,
      skipStaticAssets: cf.skipStaticAssets ?? true,
      health: cf.health ?? true,
    },
    platform: input.platform ?? 'auto',
    vercel: {
      cdn:
        vc.cdn === false
          ? null
          : { downstream: typeof vc.cdn === 'object' ? (vc.cdn.downstream ?? false) : false },
      globalConfig:
        vc.globalConfig === false
          ? null
          : { connectionEnv: vc.globalConfig?.connectionEnv ?? ['GLOBAL_CONFIG', 'EDGE_CONFIG'] },
      redis:
        vc.redis === false
          ? null
          : {
              urlEnv: vc.redis?.urlEnv ?? ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'],
              tokenEnv: vc.redis?.tokenEnv ?? ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'],
              prefix: vc.redis?.prefix ?? 'hypdriv:',
            },
      firewall: { rateLimitRules: { ...(vc.firewall?.rateLimitRules ?? {}) } },
      botId: vc.botId ? { checkLevel: vc.botId.checkLevel ?? 'basic' } : null,
      purge: {
        tokenEnv: vc.purge?.tokenEnv ?? 'VERCEL_TOKEN',
        teamIdEnv: vc.purge?.teamIdEnv ?? 'VERCEL_TEAM_ID',
        projectIdEnv: vc.purge?.projectIdEnv ?? 'VERCEL_PROJECT_ID',
      },
      cronSecretEnv: vc.cronSecretEnv ?? 'CRON_SECRET',
      queues: { ...(vc.queues ?? {}) },
    },
    devtools: {
      enabled: devtools.enabled ?? 'development',
      hotkey: devtools.hotkey ?? 'Alt+Shift+H',
      position: devtools.position ?? 'bottom-right',
      endpoint: devtools.endpoint ?? `${INTERNAL_PATH_PREFIX}/dev`,
    },
    i18n: i18n
      ? {
          locales: [...i18n.locales],
          defaultLocale: i18n.defaultLocale,
          strategy: i18n.strategy ?? 'prefix-except-default',
          cookie: i18n.cookie ?? COOKIE.locale,
          geoMap: { ...(i18n.geoMap ?? {}) },
          redirect: i18n.redirect ?? (i18n.strategy ?? 'prefix-except-default').startsWith('prefix'),
          header: i18n.header ?? HEADER.locale,
        }
      : null,
    redirects: {
      rules: (redirects.rules ?? []).map((r) => ({
        from: r.from,
        to: r.to,
        status: r.status ?? 308,
        preserveQuery: r.preserveQuery ?? true,
        host: r.host ?? null,
      })),
      kvBinding: redirects.kvBinding ?? null,
      kvKey: redirects.kvKey ?? 'redirects',
      cacheTtlSeconds: parseDuration(redirects.cacheTtl, 60),
      canonicalHost: redirects.canonicalHost ?? null,
      forceHttps: redirects.forceHttps ?? 'auto',
    },
    maintenance: {
      enabled: maintenance.enabled ?? 'env',
      envVar: maintenance.envVar ?? 'HYPDRIV_MAINTENANCE',
      kvBinding: maintenance.kvBinding ?? null,
      kvKey: maintenance.kvKey ?? 'maintenance',
      allowIps: arr(maintenance.allowIps, []),
      bypassCookie: maintenance.bypassCookie ?? null,
      bypassCookieValue: maintenance.bypassCookieValue ?? null,
      bypassPaths: arr(maintenance.bypassPaths, [`${INTERNAL_PATH_PREFIX}/**`, '/api/webhooks/**']),
      html: maintenance.html ?? null,
      retryAfterSeconds: parseDuration(maintenance.retryAfter, 300),
      status: maintenance.status ?? 503,
    },
    stages: {
      disable: arr(input.stages?.disable, []),
      order: input.stages?.order ? [...input.stages.order] : null,
    },
  };
}

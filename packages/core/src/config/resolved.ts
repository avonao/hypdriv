import type {
  BotPolicy,
  CspDirectives,
  FlagDefinition,
  HypDrivConfig,
  PurserThemeAxis,
  RateLimitPolicy,
  RedirectRule,
  RoutePattern,
  SecurityHeadersConfig,
  SpeculationEagerness,
} from './types';

/**
 * Fully resolved configuration: every section present, durations in seconds, sizes in bytes,
 * booleans expanded into objects (or `null` when disabled).
 */
export interface ResolvedConfig {
  site: { name: string; origin: string | null; basePath: string | null; trailingSlash: boolean | null };
  security: ResolvedSecurity;
  cache: ResolvedCache;
  performance: ResolvedPerformance;
  observe: ResolvedObserve;
  purser: ResolvedPurser | null;
  flags: ResolvedFlags;
  live: ResolvedLive;
  images: ResolvedImages;
  jobs: ResolvedJobs;
  budgets: ResolvedBudgets;
  platform: 'auto' | 'cloudflare' | 'vercel' | 'node';
  cloudflare: ResolvedCloudflare;
  vercel: ResolvedVercel;
  devtools: ResolvedDevtools;
  i18n: ResolvedI18n | null;
  redirects: ResolvedRedirects;
  maintenance: ResolvedMaintenance;
  stages: { disable: string[]; order: string[] | null };
}

export interface ResolvedCsp {
  mode: 'auto' | 'nonce' | 'hash' | 'off';
  reportOnly: boolean | 'both';
  directives: CspDirectives;
  allow: Required<NonNullable<import('./types').CspConfig['allow']>>;
  routes: Array<{
    match: RoutePattern;
    directives: CspDirectives;
    mode?: 'nonce' | 'hash' | 'off';
    reportOnly?: boolean;
  }>;
  strictDynamic: boolean;
  unsafeInlineStyles: boolean;
  devUnsafeEval: boolean;
  reportTo: string | null;
  reportingEndpoints: boolean;
  trustedTypes: null | { policies: string[]; allowDuplicates: boolean };
  upgradeInsecureRequests: boolean;
  nonceHeader: string;
}

export interface ResolvedSecurityHeaders {
  hsts: null | { maxAge: number; includeSubDomains: boolean; preload: boolean };
  coop: string | null;
  corp: string | null;
  coep: string | null;
  referrerPolicy: string | null;
  permissionsPolicy: Record<string, string[]> | null;
  frameOptions: string | null;
  noSniff: boolean;
  dnsPrefetchControl: string | null;
  permittedCrossDomainPolicies: string | null;
  originAgentCluster: boolean;
  stripFingerprints: boolean;
  extra: Record<string, string>;
  routes: Array<{ match: RoutePattern; headers: Partial<Omit<SecurityHeadersConfig, 'routes'>> }>;
}

export interface ResolvedRateLimitPolicy
  extends Omit<Required<Omit<RateLimitPolicy, 'skip' | 'response' | 'burst'>>, 'window' | 'key'> {
  windowSeconds: number;
  keys: Array<import('./types').RateLimitKey>;
  burst: number;
  response: { status: number; body: string | Record<string, unknown>; headers: Record<string, string> };
  skip: RateLimitPolicy['skip'] | null;
}

export interface ResolvedBots {
  verified: BotPolicy;
  likelyAutomated: BotPolicy;
  definitelyAutomated: BotPolicy;
  scoreThreshold: number;
  honeypots: string[];
  blockUserAgents: Array<string | RegExp>;
  allowUserAgents: Array<string | RegExp>;
  exempt: RoutePattern;
  secFetchChecks: boolean;
  turnstile: null | {
    siteKey: string | null;
    siteKeyEnv: string | null;
    secretEnv: string;
    action: string | null;
  };
  tarpitMs: number;
}

export interface ResolvedShield {
  methods: string[];
  maxBody: Array<{ match: RoutePattern; limit: number }>;
  maxUrlLength: number;
  blockTraversal: boolean;
  blockedPaths: string[];
  enforceHost: string[] | null;
}

export interface ResolvedSecurity {
  headers: ResolvedSecurityHeaders | null;
  csp: ResolvedCsp | null;
  rateLimit: ResolvedRateLimitPolicy[];
  bots: ResolvedBots | null;
  shield: ResolvedShield | null;
  csrf: null | {
    cookie: string;
    header: string;
    match: RoutePattern;
    exempt: RoutePattern;
    acceptSecFetchSite: boolean;
  };
  secretsScan: null | {
    patterns: Array<{ id: string; pattern: RegExp; severity: 'error' | 'warn' }>;
    ignore: string[];
    envAllowlist: string[];
    publicPrefixes: string[];
    minValueLength: number;
    failOnFinding: boolean;
  };
  sri: null | { algorithm: 'sha256' | 'sha384' | 'sha512' };
  sessions: {
    cookie: string;
    secretEnv: string;
    previousSecretEnvs: string[];
    ttlSeconds: number;
    sliding: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    path: string;
    domain: string | null;
  };
  internalAuth: { secretEnv: string; ttlSeconds: number; header: string };
  trustedProxies: number;
}

export interface ResolvedEdgeCachePolicy {
  id: string;
  match: RoutePattern;
  methods: Array<'GET' | 'HEAD'>;
  ttl: number;
  swr: number;
  staleIfError: number;
  tags: string[];
  vary: Required<import('./types').EdgeCacheVary>;
  bypass: {
    cookies: string[];
    headers: string[];
    query: string[];
    when: ((input: { url: URL; headers: Headers }) => boolean) | null;
  };
  respectOrigin: boolean;
  includeRsc: boolean;
  statuses: number[];
  keyQuery: string[] | 'all' | 'none';
  /** `explicit` from config, `inferred` from the manifest. */
  source: 'explicit' | 'inferred';
}

export interface ResolvedCache {
  edge: null | {
    policies: ResolvedEdgeCachePolicy[];
    infer: boolean;
    inferredStatic: { ttl: number; swr: number; staleIfError: number };
    inferredShell: null | { ttl: number; swr: number };
    store: import('./types').CacheStoreKind;
    /** Seconds; `0` disables the memory tier in front of shared stores. */
    memoryTtl: number;
    negativeTtl: number;
    ignoredQuery: string[];
    maxBodySize: number;
    purge: { zoneIdEnv: string; tokenEnv: string; index: 'auto' | 'kv' | 'durable-object' | 'none' };
    emitTagHeaders: boolean;
    debugHeader: boolean;
  };
  warm: { routes: string[]; onDeploy: boolean; cron: string | null; concurrency: number };
}

export interface ResolvedSpeculation {
  prerender: null | { eagerness: SpeculationEagerness; include: string[]; exclude: string[]; topN: number };
  prefetch: null | { eagerness: SpeculationEagerness; include: string[]; exclude: string[] };
  exclude: string[];
  useGraph: boolean;
  inject: 'auto' | 'edge' | 'component' | 'off';
}

export interface ResolvedPerformance {
  earlyHints: null | {
    preconnect: string[];
    fonts: boolean;
    styles: boolean;
    scripts: boolean | 'main';
    purser: boolean;
    maxLinks: number;
    onRsc: boolean;
  };
  speculation: ResolvedSpeculation | null;
  priorityHints: null | { selectors: string[] };
  skewProtection: null | { deploymentId: string | null; reloadOnMismatch: boolean };
  fetch: {
    timeoutMs: number;
    retries: number;
    retryOn: number[];
    backoff: { baseMs: number; maxMs: number; jitter: boolean };
    circuitBreaker: null | { failureThreshold: number; cooldownMs: number; halfOpenMax: number };
  };
  html: { stripComments: boolean; collapseWhitespace: boolean };
}

export interface ResolvedObserve {
  tracing: null | {
    exporter: 'console' | 'otlp' | 'analytics-engine' | 'none';
    serviceName: string;
    sampleRate: number;
    otlp: null | {
      url: string;
      headers: Record<string, string>;
      headersEnv: string | null;
      timeoutMs: number;
    };
    analyticsEngineBinding: string;
    propagate: boolean;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
    format: 'json' | 'pretty';
    redact: string[];
    sampleRate: number;
    requests: boolean;
  };
  serverTiming: 'off' | 'compact' | 'verbose' | 'auto';
  vitals: null | {
    endpoint: string;
    sampleRate: number;
    sink: 'log' | 'analytics-engine' | 'none';
    analyticsEngineBinding: string;
    attribution: boolean;
  };
  errors: { sink: 'log' | 'otlp' | 'none'; includeStack: boolean };
}

export interface ResolvedPurser {
  enabled: boolean | 'auto';
  project: string;
  src: string[];
  tokens: string | null;
  out: string;
  prefix: string;
  salt: string;
  packageName: string;
  cssModule: string | null;
  layers: { tokens: string; globals: string; atoms: string };
  verify: 'error' | 'warn' | 'off';
  usageReport: boolean;
  theme: null | {
    cookie: string;
    axes: Record<
      string,
      Required<Omit<PurserThemeAxis, 'clientHint'>> & { clientHint: PurserThemeAxis['clientHint'] | null }
    >;
    fallbackScript: boolean;
    acceptClientHints: boolean;
  };
  audit: { widths: number[]; states: Array<'default' | 'hover' | 'focus'>; routes: string[] | null };
  earlyHints: boolean;
  checkInDoctor: boolean;
}

export interface ResolvedFlags {
  definitions: Record<string, FlagDefinition>;
  provider: 'static' | 'env' | 'kv' | 'openfeature';
  envVar: string;
  kvBinding: string;
  kvKey: string;
  idCookie: string;
  header: string;
  queryOverrides: boolean | 'development';
  refreshSeconds: number;
}

export interface ResolvedLive {
  enabled: boolean;
  binding: string;
  transport: 'auto' | 'sse' | 'websocket' | 'polling';
  pollIntervalMs: number;
  path: string;
  maxSubscribers: number;
  retain: number;
  authorize: import('./types').LiveConfig['authorize'] | null;
}

export interface ResolvedImages {
  loader: 'auto' | 'cloudflare' | 'next' | 'none';
  cdnCgi: boolean | 'auto';
  quality: number;
  formats: Array<'avif' | 'webp' | 'auto'>;
  placeholders: { enabled: boolean; file: string; size: number; sources: string[] };
  allowedHosts: string[];
}

export interface ResolvedJobs {
  cron: Record<string, { cron: string; path: string; timeoutMs: number; method: 'GET' | 'POST' }>;
  queues: Record<
    string,
    { path: string; retry: 'failed' | 'all' | 'none'; maxConcurrency: number; queues: string[] }
  >;
  email: { path: string } | null;
  basePath: string;
}

export interface ResolvedBudgets {
  routes: Record<string, { js: number | null; css: number | null; html: number | null }>;
  worker: { raw: number | null; gzip: number | null; startupMs: number | null };
  totalJs: number | null;
  failOn: 'error' | 'warn' | 'never';
  snapshotDir: string;
}

export interface ResolvedCloudflare {
  bindings: {
    kv: string;
    tagIndex: string;
    limiter: string;
    channel: string;
    rateLimit: string;
    analyticsEngine: string;
    images: string;
    assets: string;
    queues: Record<string, string>;
    ai: string;
  };
  smartPlacement: boolean;
  runWorkerFirst: boolean | string[];
  internalPathPrefix: string;
  skipStaticAssets: boolean;
  health: boolean;
}

export interface ResolvedVercel {
  cdn: null | { downstream: boolean };
  globalConfig: null | { connectionEnv: string[] };
  redis: null | { urlEnv: string[]; tokenEnv: string[]; prefix: string };
  firewall: { rateLimitRules: Record<string, string> };
  botId: null | { checkLevel: 'basic' | 'deepAnalysis' };
  purge: { tokenEnv: string; teamIdEnv: string; projectIdEnv: string };
  cronSecretEnv: string;
  queues: Record<string, string>;
}

export interface ResolvedDevtools {
  enabled: boolean | 'development' | 'preview';
  hotkey: string;
  position: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  endpoint: string;
}

export interface ResolvedI18n {
  locales: string[];
  defaultLocale: string;
  strategy: 'prefix' | 'prefix-except-default' | 'header' | 'cookie';
  cookie: string;
  geoMap: Record<string, string>;
  redirect: boolean;
  header: string;
}

export interface ResolvedRedirects {
  rules: Array<Required<Omit<RedirectRule, 'host'>> & { host: string | null }>;
  kvBinding: string | null;
  kvKey: string;
  cacheTtlSeconds: number;
  canonicalHost: string | null;
  forceHttps: boolean | 'auto';
}

export interface ResolvedMaintenance {
  enabled: boolean | 'env';
  envVar: string;
  kvBinding: string | null;
  kvKey: string;
  allowIps: string[];
  bypassCookie: string | null;
  bypassCookieValue: string | null;
  bypassPaths: string[];
  html: string | null;
  retryAfterSeconds: number;
  status: 503 | 200;
}

export type { HypDrivConfig };

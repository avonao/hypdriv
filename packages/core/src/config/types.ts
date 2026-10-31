/**
 * HypDriv configuration schema.
 *
 * `hypdriv.config.ts` exports `defineConfig({...})` with this shape. Every section is optional;
 * `resolveConfig()` applies the documented defaults and produces a `ResolvedConfig` whose
 * sections are always present so runtime code never checks for `undefined`.
 *
 * Durations accept a number of seconds or a string with a unit: `'30s'`, `'5m'`, `'2h'`, `'1d'`.
 * Sizes accept a number of bytes or a string with a unit: `'250kb'`, `'3mb'`.
 */

export type Duration = number | string;
export type Size = number | string;

/** A route pattern: Next-style (`/blog/:slug`, `/docs/*`, `/api/**`), a regex, or a list of both. */
export type RoutePattern = string | RegExp | Array<string | RegExp>;

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

export interface SiteConfig {
  /** Human-readable name, used in logs, maintenance pages and the HUD. */
  name?: string;
  /** Canonical origin (`https://www.example.com`). Used for absolute URLs, HSTS preload advice and audits. */
  origin?: string;
  /** Mirrors Next's `basePath`; detected from the manifest when omitted. */
  basePath?: string;
  /** Mirrors Next's `trailingSlash`; detected from the manifest when omitted. */
  trailingSlash?: boolean;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export type CspSourceList = string[];

export interface CspDirectives {
  'default-src'?: CspSourceList;
  'script-src'?: CspSourceList;
  'script-src-elem'?: CspSourceList;
  'script-src-attr'?: CspSourceList;
  'style-src'?: CspSourceList;
  'style-src-elem'?: CspSourceList;
  'style-src-attr'?: CspSourceList;
  'img-src'?: CspSourceList;
  'font-src'?: CspSourceList;
  'connect-src'?: CspSourceList;
  'media-src'?: CspSourceList;
  'object-src'?: CspSourceList;
  'frame-src'?: CspSourceList;
  'child-src'?: CspSourceList;
  'worker-src'?: CspSourceList;
  'manifest-src'?: CspSourceList;
  'base-uri'?: CspSourceList;
  'form-action'?: CspSourceList;
  'frame-ancestors'?: CspSourceList;
  'navigate-to'?: CspSourceList;
  'report-uri'?: CspSourceList;
  'report-to'?: CspSourceList;
  sandbox?: CspSourceList;
  'upgrade-insecure-requests'?: boolean;
  'block-all-mixed-content'?: boolean;
  'require-trusted-types-for'?: CspSourceList;
  'trusted-types'?: CspSourceList;
  [directive: string]: CspSourceList | boolean | undefined;
}

export interface CspConfig {
  /**
   * `auto` picks hash mode for fully static routes and nonce mode for everything else (ADR 0006).
   * `nonce` and `hash` force one mode; `off` disables CSP emission (headers from the app still pass through).
   */
  mode?: 'auto' | 'nonce' | 'hash' | 'off';
  /** `true` emits `Content-Security-Policy-Report-Only`; `'both'` emits the enforced policy and a stricter report-only policy. */
  reportOnly?: boolean | 'both';
  /** Base directives. Merged over the strict preset; per-route overrides merge over these. */
  directives?: CspDirectives;
  /** Shorthand allow-lists appended to the matching directives. */
  allow?: {
    scripts?: string[];
    styles?: string[];
    images?: string[];
    fonts?: string[];
    connect?: string[];
    frames?: string[];
    media?: string[];
    workers?: string[];
    frameAncestors?: string[];
    formAction?: string[];
  };
  /** Per-route overrides, matched in order; the first match wins. */
  routes?: Array<{
    match: RoutePattern;
    directives?: CspDirectives;
    mode?: 'nonce' | 'hash' | 'off';
    reportOnly?: boolean;
  }>;
  /** `'strict-dynamic'` on script-src (default true). */
  strictDynamic?: boolean;
  /** Adds `'unsafe-inline'` to style-src (default true: React and Next emit inline style attributes and tags). */
  unsafeInlineStyles?: boolean;
  /** Adds `'unsafe-eval'` to script-src in development only (default true; Turbopack HMR needs it). */
  devUnsafeEval?: boolean;
  /** Reporting endpoint path or absolute URL. `false` disables reporting. Default `/_hypdriv/csp-report`. */
  reportTo?: string | false;
  /** Emit `Reporting-Endpoints` header alongside `report-to` (default true). */
  reportingEndpoints?: boolean;
  /** Trusted Types enforcement (`require-trusted-types-for 'script'`). Default false. */
  trustedTypes?: boolean | { policies: string[]; allowDuplicates?: boolean };
  /** `upgrade-insecure-requests` (default true in production). */
  upgradeInsecureRequests?: boolean;
  /** Name of the request header that carries the nonce to the application (default `x-nonce`). */
  nonceHeader?: string;
}

export interface SecurityHeadersConfig {
  hsts?: false | { maxAge?: Duration; includeSubDomains?: boolean; preload?: boolean };
  /** `Cross-Origin-Opener-Policy`. Default `same-origin-allow-popups`. */
  coop?: false | 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | 'noopener-allow-popups';
  /** `Cross-Origin-Resource-Policy`. Default `same-site`. */
  corp?: false | 'same-origin' | 'same-site' | 'cross-origin';
  /** `Cross-Origin-Embedder-Policy`. Default off (breaks third-party embeds without CORP headers). */
  coep?: false | 'require-corp' | 'credentialless';
  /** `Referrer-Policy`. Default `strict-origin-when-cross-origin`. */
  referrerPolicy?: false | string;
  /** `Permissions-Policy` features. Default denies the sensitive set; pass `{ camera: ['self'] }` to allow. */
  permissionsPolicy?: false | Record<string, Array<'self' | '*' | string> | []>;
  /** `X-Frame-Options`, kept for legacy agents; `frame-ancestors` is authoritative. Default `DENY`. */
  frameOptions?: false | 'DENY' | 'SAMEORIGIN';
  /** `X-Content-Type-Options: nosniff` (default true). */
  noSniff?: boolean;
  /** `X-DNS-Prefetch-Control` (default `on`). */
  dnsPrefetchControl?: false | 'on' | 'off';
  /** `X-Permitted-Cross-Domain-Policies` (default `none`). */
  permittedCrossDomainPolicies?: false | 'none' | 'master-only' | 'by-content-type' | 'all';
  /** `Origin-Agent-Cluster: ?1` (default true). */
  originAgentCluster?: boolean;
  /** Remove `X-Powered-By` and `Server` fingerprints (default true). */
  stripFingerprints?: boolean;
  /** Extra headers merged last. */
  extra?: Record<string, string>;
  /** Per-route overrides. */
  routes?: Array<{ match: RoutePattern; headers: Partial<Omit<SecurityHeadersConfig, 'routes'>> }>;
}

export type RateLimitAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';
export type RateLimitKey = 'ip' | 'session' | 'user' | 'api-key' | 'path' | 'global';
export type RateLimitStore = 'auto' | 'memory' | 'cache-api' | 'kv' | 'durable-object' | 'binding';

export interface RateLimitPolicy {
  /** Stable id, used in headers, logs and the HUD. */
  id: string;
  match: RoutePattern;
  methods?: string[];
  /** Requests allowed per window (or bucket capacity for token-bucket). */
  limit: number;
  /** Window length (or refill period for token-bucket). */
  window: Duration;
  /** Extra burst capacity for token-bucket. */
  burst?: number;
  algorithm?: RateLimitAlgorithm;
  key?: RateLimitKey | RateLimitKey[];
  store?: RateLimitStore;
  /** Header name for `api-key` keys (default `authorization`). */
  apiKeyHeader?: string;
  /** Cookie name for `session` keys (default from `security.sessions.cookie`). */
  sessionCookie?: string;
  /** Request header set by auth layers for `user` keys (default `x-user-id`). */
  userHeader?: string;
  /** Response when limited: default JSON 429 with `Retry-After`. */
  response?: { status?: number; body?: string | Record<string, unknown>; headers?: Record<string, string> };
  /** Emit IETF `RateLimit-*` headers (default true). */
  headers?: boolean;
  /** Skip the policy when the predicate returns true (e.g. internal traffic). */
  skip?: (input: { ip: string; url: URL; headers: Headers }) => boolean;
}

export type BotPolicy = 'allow' | 'challenge' | 'block' | 'tarpit' | 'log';

export interface BotConfig {
  /** Verified search/social bots (Cloudflare's `verifiedBotCategory` or UA list). Default `allow`. */
  verified?: BotPolicy;
  /** Likely automated traffic (score < threshold or heuristics). Default `log`. */
  likelyAutomated?: BotPolicy;
  /** Definitely automated / known bad agents. Default `block`. */
  definitelyAutomated?: BotPolicy;
  /** Bot Management score threshold below which traffic is "likely automated" (default 30). */
  scoreThreshold?: number;
  /** Honeypot paths that no human should request. Default `['/wp-login.php', '/wp-admin', '/.env', '/.git/config', '/xmlrpc.php']`. */
  honeypots?: string[];
  /** Additional user-agent substrings or regexes treated as definitely automated. */
  blockUserAgents?: Array<string | RegExp>;
  /** User-agent substrings always allowed. */
  allowUserAgents?: Array<string | RegExp>;
  /** Paths exempt from bot handling (default `['/_next/*', '/_hypdriv/*', '/api/webhooks/*']`). */
  exempt?: RoutePattern;
  /** Validate `Sec-Fetch-*` headers on non-GET API requests (default true). */
  secFetchChecks?: boolean;
  /** Turnstile configuration for `challenge` policies. */
  /**
   * Turnstile configuration for `challenge` policies. The site key is public: set it inline (`siteKey`) or per
   * environment through a variable (`siteKeyEnv`, read at request time; one of the two is required).
   */
  turnstile?: { siteKey?: string; siteKeyEnv?: string; secretEnv?: string; action?: string };
  /** Tarpit delay in milliseconds (default 3000, max 10000). */
  tarpitMs?: number;
}

export interface ShieldConfig {
  /** Allowed methods (default `['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']`). */
  methods?: string[];
  /** Max request body size by route (first match wins). Default `'10mb'` globally, `'1mb'` for `/api/**`. */
  maxBody?: Array<{ match: RoutePattern; limit: Size }> | Size;
  /** Max URL length (default 8192). */
  maxUrlLength?: number;
  /** Reject encoded traversal and null bytes (default true). */
  blockTraversal?: boolean;
  /** Paths that always 404 (hidden files, backups). Defaults cover `.env*`, `.git`, `*.bak`, `*.sql`, keys and config files. */
  blockedPaths?: string[];
  /** Reject requests whose `Host` is not in `site.origin`/allowed hosts (default false; Cloudflare routes already bound). */
  enforceHost?: boolean | string[];
}

export interface CsrfConfig {
  /** Cookie that holds the token (default `hyp_csrf`). */
  cookie?: string;
  /** Header or form field that must echo it (default `x-csrf-token`). */
  header?: string;
  /** Routes protected (default `/api/**` for unsafe methods). */
  match?: RoutePattern;
  /** Routes exempt (webhooks). Default `['/api/webhooks/**', '/_hypdriv/**']`. */
  exempt?: RoutePattern;
  /** Also accept same-origin `Sec-Fetch-Site` as proof (default true). */
  acceptSecFetchSite?: boolean;
}

export interface SecretsScanConfig {
  /** Additional regex patterns `{ id, pattern }`. */
  patterns?: Array<{ id: string; pattern: RegExp | string; severity?: 'error' | 'warn' }>;
  /** Pattern ids to ignore. */
  ignore?: string[];
  /** Environment variable names whose values may legitimately appear in client code. */
  envAllowlist?: string[];
  /** Prefixes considered public (default `['NEXT_PUBLIC_']`). */
  publicPrefixes?: string[];
  /** Minimum length of an env value to be considered (default 12). */
  minValueLength?: number;
  /** Fail the build on findings (default true). */
  failOnFinding?: boolean;
}

export interface SessionConfig {
  cookie?: string;
  /** Environment variable holding the base secret (default `HYPDRIV_SESSION_SECRET`). */
  secretEnv?: string;
  /** Additional previous secrets for rotation (env names). */
  previousSecretEnvs?: string[];
  ttl?: Duration;
  /** Extend expiry on each request when more than `slidingThreshold` of the TTL has passed (default true). */
  sliding?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  /** Default true; set false only for local http testing. */
  secure?: boolean;
  path?: string;
  domain?: string;
}

export interface SecurityConfig {
  headers?: boolean | SecurityHeadersConfig;
  csp?: boolean | CspConfig;
  rateLimit?: RateLimitPolicy[];
  bots?: boolean | BotConfig;
  shield?: boolean | ShieldConfig;
  csrf?: boolean | CsrfConfig;
  secretsScan?: boolean | SecretsScanConfig;
  sri?: boolean | { algorithm: 'sha256' | 'sha384' | 'sha512' };
  sessions?: SessionConfig;
  /** HMAC authentication for internal requests (cron/queue → route handlers). */
  internalAuth?: { secretEnv?: string; ttl?: Duration; header?: string };
  /** Trusted proxy depth for client IP extraction when not on Cloudflare (default 0 → `x-forwarded-for` last hop). */
  trustedProxies?: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export type CacheStoreKind = 'auto' | 'cache-api' | 'memory' | 'kv' | 'tiered';

export interface EdgeCacheVary {
  headers?: string[];
  cookies?: string[];
  geo?: Array<'country' | 'region' | 'city' | 'continent' | 'timezone' | 'colo'>;
  flags?: string[];
  /** Vary on negotiated locale (default false). */
  language?: boolean;
  /** Vary on device class (mobile/desktop) derived from client hints or UA (default false). */
  device?: boolean;
}

export interface EdgeCachePolicy {
  id?: string;
  match: RoutePattern;
  methods?: Array<'GET' | 'HEAD'>;
  ttl: Duration;
  swr?: Duration;
  staleIfError?: Duration;
  /** Static tags plus the automatic `route:<id>` and `build:<id>` tags. */
  tags?: string[];
  vary?: EdgeCacheVary;
  /** Bypass the cache when any listed cookie/header/query is present, or when `when` returns true. */
  bypass?: {
    cookies?: string[];
    headers?: string[];
    query?: string[];
    when?: (input: { url: URL; headers: Headers }) => boolean;
  };
  /** Honour the origin's `Cache-Control` (`no-store`, `private`, `max-age`) instead of the policy (default true). */
  respectOrigin?: boolean;
  /** Cache RSC payload requests for the route too (default true). */
  includeRsc?: boolean;
  /** Cacheable statuses (default `[200, 203, 204, 301, 308, 404, 410]`). */
  statuses?: number[];
  /** Query parameters that are part of the key (default: all except tracking params). `[]` ignores the query entirely. */
  keyQuery?: string[] | 'all' | 'none';
}

export interface CacheConfig {
  edge?:
    | boolean
    | {
        /** Explicit policies (first match wins). */
        policies?: EdgeCachePolicy[];
        /** Infer policies for routes without an explicit one from the manifest (default true). */
        infer?: boolean;
        /** Default TTL / SWR for inferred static routes. */
        inferredStatic?: { ttl?: Duration; swr?: Duration; staleIfError?: Duration };
        /** Cache shell (PPR) HTML responses when inferred (default false). */
        inferredShell?: false | { ttl?: Duration; swr?: Duration };
        store?: CacheStoreKind;
        /**
         * Longest time an isolate's in-memory tier serves an entry before reading the shared tiers again
         * (Cache API, KV) when it fronts them (default `'10s'`; `0` disables the memory tier). Purges run in
         * one isolate, so this bounds how long other isolates can serve a purged copy.
         */
        memoryTtl?: Duration;
        /** Negative-cache TTL for 404/410 (default `'60s'`, `0` disables). */
        negativeTtl?: Duration;
        /** Query parameters removed from keys and from upstream requests (default: common tracking parameters). */
        ignoredQuery?: string[];
        /** Max cacheable body size (default `'5mb'`). */
        maxBodySize?: Size;
        /** Zone purge through the Cloudflare API when a token is available. */
        purge?: { zoneIdEnv?: string; tokenEnv?: string; index?: 'auto' | 'kv' | 'durable-object' | 'none' };
        /** Emit `Cache-Tag` / `Surrogate-Key` response headers (default true). */
        emitTagHeaders?: boolean;
        /** Add `x-hypdriv-cache` debug header (default true). */
        debugHeader?: boolean;
      };
  /** Routes warmed by `hypdriv warm` and by the scheduled handler. */
  warm?: { routes?: string[]; onDeploy?: boolean; cron?: string; concurrency?: number };
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export type SpeculationEagerness = 'immediate' | 'eager' | 'moderate' | 'conservative';

export interface SpeculationConfig {
  prerender?:
    | false
    | {
        eagerness?: SpeculationEagerness;
        /** Document-rule patterns included (default all same-origin links). */
        include?: string[];
        exclude?: string[];
        /** Hard cap on explicit `urls` per route generated from the graph (default 5). */
        topN?: number;
      };
  prefetch?: false | { eagerness?: SpeculationEagerness; include?: string[]; exclude?: string[] };
  /** Patterns never speculated (default: logout, api, auth, cart/checkout, query strings with tokens). */
  exclude?: string[];
  /** Use the link graph from the manifest to add explicit high-probability URLs (default true). */
  useGraph?: boolean;
  /** Where to inject: `edge` (HTMLRewriter) or `component` (`<Speculation/>`). Default `auto`. */
  inject?: 'auto' | 'edge' | 'component' | 'off';
}

export interface EarlyHintsConfig {
  /** Origins to preconnect on every route. */
  preconnect?: string[];
  fonts?: boolean;
  styles?: boolean;
  /** `true` preloads all route scripts; `'main'` only the main/runtime chunks (default). */
  scripts?: boolean | 'main';
  /** Include the Purser stylesheet (default true when Purser is enabled). */
  purser?: boolean;
  /** Max Link entries per response (default 12). */
  maxLinks?: number;
  /** Also emit `Link` on RSC/prefetch responses (default false). */
  onRsc?: boolean;
}

export interface PerformanceConfig {
  earlyHints?: boolean | EarlyHintsConfig;
  speculation?: boolean | SpeculationConfig;
  /** Add `fetchpriority="high"` to the first matching image (edge only). Default off. */
  priorityHints?: false | { selectors: string[] };
  /** Skew protection assist: auto `deploymentId`, reload instruction on mismatch (default true). */
  skewProtection?: boolean | { deploymentId?: string; reloadOnMismatch?: boolean };
  /** Defaults for `hypFetch`. */
  fetch?: {
    timeout?: Duration;
    retries?: number;
    retryOn?: number[];
    backoff?: { baseMs?: number; maxMs?: number; jitter?: boolean };
    circuitBreaker?: false | { failureThreshold?: number; cooldown?: Duration; halfOpenMax?: number };
  };
  /** Streaming HTML transforms (edge only, all default off). */
  html?: { stripComments?: boolean; collapseWhitespace?: boolean };
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface ObserveConfig {
  tracing?:
    | boolean
    | {
        exporter?: 'console' | 'otlp' | 'analytics-engine' | 'none';
        serviceName?: string;
        sampleRate?: number;
        otlp?: { url: string; headers?: Record<string, string>; headersEnv?: string; timeout?: Duration };
        analyticsEngineBinding?: string;
        /** Propagate `traceparent` to outgoing `hypFetch` calls (default true). */
        propagate?: boolean;
      };
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
    format?: 'json' | 'pretty';
    /** Additional field names to redact. */
    redact?: string[];
    /** Sample rate for `info`/`debug` lines (default 1). */
    sampleRate?: number;
    /** Log every request summary line (default true). */
    requests?: boolean;
  };
  /** `compact` in production, `verbose` in dev/preview by default. */
  serverTiming?: boolean | 'compact' | 'verbose';
  vitals?:
    | boolean
    | {
        endpoint?: string;
        sampleRate?: number;
        sink?: 'log' | 'analytics-engine' | 'none';
        analyticsEngineBinding?: string;
        /** Include attribution (LCP element, INP target, CLS sources) (default true). */
        attribution?: boolean;
      };
  errors?: { sink?: 'log' | 'otlp' | 'none'; includeStack?: boolean };
}

// ---------------------------------------------------------------------------
// Purser
// ---------------------------------------------------------------------------

export interface PurserThemeAxis {
  /** Cookie key or query name for the axis (default: axis name). */
  cookie?: string;
  /** Class name applied for each value; `null` means "no class" (e.g. light). */
  classes: Record<string, string | null>;
  default: string;
  /** Map a client hint to values, e.g. `{ hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } }`. */
  clientHint?: {
    hint: 'prefers-color-scheme' | 'prefers-contrast' | 'prefers-reduced-motion';
    values: Record<string, string>;
  };
}

export interface PurserConfig {
  /** Default: enabled when `@avonao/purser` is installed and a tokens file is configured or detected. */
  enabled?: boolean;
  project?: string;
  src?: string[];
  tokens?: string;
  out?: string;
  prefix?: string;
  salt?: string;
  packageName?: string;
  cssModule?: string;
  layers?: { tokens?: string; globals?: string; atoms?: string };
  /** Unstyled-atom guard after `next build` (default `error`). */
  verify?: 'error' | 'warn' | 'off';
  usageReport?: boolean;
  /** Theme pinning at the edge and the hashed fallback script. */
  theme?: {
    cookie?: string;
    axes: Record<string, PurserThemeAxis>;
    fallbackScript?: boolean;
    acceptClientHints?: boolean;
  };
  audit?: { widths?: number[]; states?: Array<'default' | 'hover' | 'focus'>; routes?: string[] };
  earlyHints?: boolean;
  /** Run `purser check` as part of `hypdriv doctor` (default true). */
  checkInDoctor?: boolean;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type FlagValue = boolean | string | number;

export interface FlagRule {
  when?: {
    country?: string[];
    continent?: string[];
    path?: string[];
    cookie?: Record<string, string | string[]>;
    header?: Record<string, string | string[]>;
    device?: 'mobile' | 'desktop' | 'bot';
    /** Date window (ISO strings). */
    from?: string;
    until?: string;
    /** Another flag must evaluate to this value. */
    flag?: Record<string, FlagValue>;
  };
  /** 0–100; bucketing is deterministic per stable id and flag name. */
  percentage?: number;
  value: FlagValue;
}

export interface FlagDefinition {
  description?: string;
  default: FlagValue;
  rules?: FlagRule[];
  /** Hide from client propagation (default false). */
  serverOnly?: boolean;
}

export interface FlagsConfig {
  definitions?: Record<string, FlagDefinition>;
  /** `static` (definitions only), `env` (JSON in an env var), `kv` (KV namespace), `openfeature` (an OpenFeature client supplied at runtime). */
  provider?: 'static' | 'env' | 'kv' | 'openfeature';
  envVar?: string;
  kvBinding?: string;
  kvKey?: string;
  /** Cookie that carries the stable id for bucketing (default `hyp_uid`). */
  idCookie?: string;
  header?: string;
  /** Allow `?hyp_flag_<name>=` overrides: `true`, `false` or `'development'` (default). */
  queryOverrides?: boolean | 'development';
  /** Refresh interval for remote providers (default `'30s'`). */
  refresh?: Duration;
}

// ---------------------------------------------------------------------------
// Live, images, jobs, budgets, cloudflare, devtools, i18n, redirects, maintenance
// ---------------------------------------------------------------------------

export interface LiveConfig {
  enabled?: boolean;
  binding?: string;
  transport?: 'auto' | 'sse' | 'websocket' | 'polling';
  pollInterval?: Duration;
  path?: string;
  /** Max subscribers per channel per object (default 10000). */
  maxSubscribers?: number;
  /** Retained events per channel for late joiners (default 50). */
  retain?: number;
  /** Authorise subscriptions. Default: public. */
  authorize?: (input: { channel: string; headers: Headers; url: URL }) => boolean | Promise<boolean>;
}

export interface ImagesConfig {
  /**
   * `auto` (default): the Cloudflare loader on Cloudflare, Next's built-in optimizer elsewhere (on Vercel a
   * custom loader would bypass Vercel Image Optimization).
   */
  loader?: 'auto' | 'cloudflare' | 'next' | 'none';
  /** Use `/cdn-cgi/image/...` URLs (requires a zone) instead of `/_next/image` (default `auto`). */
  cdnCgi?: boolean | 'auto';
  quality?: number;
  formats?: Array<'avif' | 'webp' | 'auto'>;
  placeholders?: { enabled?: boolean; file?: string; size?: number; sources?: string[] };
  /** Remote patterns mirrored from next.config for validation. */
  allowedHosts?: string[];
}

export interface JobsConfig {
  /** Cron jobs: name → `{ cron, path }`. The Worker's `scheduled` handler dispatches by cron expression. */
  cron?: Record<string, { cron: string; path: string; timeout?: Duration; method?: 'GET' | 'POST' }>;
  /**
   * Queue consumers: queue name → `{ path }`. The key is the name `enqueue()` uses; `queues` lists the
   * deployed Cloudflare queue names the consumer receives batches from when they differ per environment
   * (`my-app-jobs-staging`, `my-app-jobs`), with `*` as a wildcard (`'*-jobs'`). Default: the key itself.
   */
  queues?: Record<
    string,
    { path: string; retry?: 'failed' | 'all' | 'none'; maxConcurrency?: number; queues?: string[] }
  >;
  email?: { path: string };
  /** Base path for scaffolded job handlers (default `/api/jobs`). */
  basePath?: string;
}

export interface BudgetsConfig {
  /** Route pattern → budgets for client assets (gzip estimates). */
  routes?: Record<string, { js?: Size; css?: Size; html?: Size }>;
  /** Budgets for the Worker bundle. */
  worker?: { raw?: Size; gzip?: Size; startupMs?: number };
  /** Sum of all unique client JS. */
  totalJs?: Size;
  /** `error` fails the build, `warn` reports (default `warn`). */
  failOn?: 'error' | 'warn' | 'never';
  /** Snapshot directory for diffs (default `.hypdriv/snapshots`). */
  snapshotDir?: string;
}

export interface CloudflareConfig {
  bindings?: {
    kv?: string;
    tagIndex?: string;
    limiter?: string;
    channel?: string;
    rateLimit?: string;
    analyticsEngine?: string;
    images?: string;
    assets?: string;
    queues?: Record<string, string>;
    ai?: string;
  };
  smartPlacement?: boolean;
  runWorkerFirst?: boolean | string[];
  /** Prefix for HypDriv's internal routes (default `/_hypdriv`). */
  internalPathPrefix?: string;
  /** Bypass the Drivetrain for static asset paths entirely (default true). */
  skipStaticAssets?: boolean;
  /** Respond to `/_hypdriv/health` (default true). */
  health?: boolean;
}

/** Where the application runs. `auto` detects it (Vercel env, workerd, otherwise Node). */
export type DeployTarget = 'cloudflare' | 'vercel' | 'node';

/**
 * Vercel integration (used when the deploy target is `vercel`). Every entry is an optional upgrade over the
 * zero-infrastructure baseline, detected from the environment at run time.
 */
export interface VercelConfig {
  /**
   * Express edge-cache policies as Vercel CDN headers (`Vercel-CDN-Cache-Control`, `Vercel-Cache-Tag`).
   * `downstream: true` also emits `CDN-Cache-Control` for CDNs in front of Vercel. Default true.
   */
  cdn?: boolean | { downstream?: boolean };
  /** Global Config (formerly Edge Config) as the read-only key-value source for flags, redirects and maintenance. Default env `GLOBAL_CONFIG`, then `EDGE_CONFIG`. */
  globalConfig?: false | { connectionEnv?: string[] };
  /** Redis over Upstash's REST API (Vercel Marketplace) as the KV store for rate limits, tag index and idempotency. */
  redis?: false | { urlEnv?: string[]; tokenEnv?: string[]; prefix?: string };
  /** Vercel WAF rate-limit rules (`@vercel/firewall`) to enforce per HypDriv rate-limit policy id. */
  firewall?: { rateLimitRules?: Record<string, string> };
  /**
   * Vercel BotID: the default check level of `botIdGuard()` (`basic` is free on every plan; `deepAnalysis` is
   * billed and enabled in the Firewall settings). Requires `botid` registered with `registerVercelSdk` and
   * `initBotId()` on the client for the protected paths.
   */
  botId?: false | { checkLevel?: 'basic' | 'deepAnalysis' };
  /** REST fallback for tag purges when `@vercel/functions` cannot purge (outside a Vercel function). */
  purge?: { tokenEnv?: string; teamIdEnv?: string; projectIdEnv?: string };
  /** Env holding the secret Vercel Cron sends as `Authorization: Bearer …` (default `CRON_SECRET`). */
  cronSecretEnv?: string;
  /** Vercel Queues topic per HypDriv queue name (default: the queue name). */
  queues?: Record<string, string>;
}

export interface DevtoolsConfig {
  /** `true`, `false`, `'development'` (default) or `'preview'` (dev + wrangler preview). */
  enabled?: boolean | 'development' | 'preview';
  hotkey?: string;
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  /** Dev endpoint path served by proxy/worker (default `/_hypdriv/dev`). */
  endpoint?: string;
}

export interface I18nConfig {
  locales: string[];
  defaultLocale: string;
  /** `prefix` (`/en/...`), `prefix-except-default`, `header` (no URL change), `cookie`. Default `prefix-except-default`. */
  strategy?: 'prefix' | 'prefix-except-default' | 'header' | 'cookie';
  cookie?: string;
  /** Country → locale hints used when `Accept-Language` is absent. */
  geoMap?: Record<string, string>;
  /** Redirect `/` to the negotiated locale (default true for prefix strategies). */
  redirect?: boolean;
  /** Header exposing the negotiated locale to the app (default `x-hypdriv-locale`). */
  header?: string;
}

export interface RedirectRule {
  from: string;
  to: string;
  status?: 301 | 302 | 307 | 308;
  preserveQuery?: boolean;
  /** Only when the host matches. */
  host?: string;
}

export interface RedirectsConfig {
  rules?: RedirectRule[];
  /** Load additional rules from KV (`JSON` array under `kvKey`). */
  kvBinding?: string;
  kvKey?: string;
  /** How long KV rules are cached in memory (default `'60s'`). */
  cacheTtl?: Duration;
  /** Canonical host redirect (e.g. apex → www) (default off). */
  canonicalHost?: string;
  /** Force https (default true when `site.origin` is https). */
  forceHttps?: boolean;
}

export interface MaintenanceConfig {
  /** `true`, `false` or `'env'` to read `envVar` at request time (default `'env'`). */
  enabled?: boolean | 'env';
  envVar?: string;
  kvBinding?: string;
  kvKey?: string;
  allowIps?: string[];
  /** Cookie that bypasses maintenance (value compared to `bypassCookieValue`). */
  bypassCookie?: string;
  bypassCookieValue?: string;
  bypassPaths?: string[];
  html?: string;
  retryAfter?: Duration;
  status?: 503 | 200;
}

export interface StagesConfig {
  /** Stage names to disable. */
  disable?: string[];
  /** Full custom order; unknown names are ignored, missing names appended in default order. */
  order?: string[];
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface HypDrivConfig {
  site?: SiteConfig;
  security?: SecurityConfig;
  cache?: CacheConfig;
  performance?: PerformanceConfig;
  observe?: ObserveConfig;
  purser?: false | PurserConfig;
  flags?: FlagsConfig;
  live?: LiveConfig;
  images?: ImagesConfig;
  jobs?: JobsConfig;
  budgets?: BudgetsConfig;
  /** Deploy target (default `auto`). */
  platform?: 'auto' | DeployTarget;
  cloudflare?: CloudflareConfig;
  vercel?: VercelConfig;
  devtools?: boolean | DevtoolsConfig;
  i18n?: I18nConfig;
  redirects?: RedirectsConfig;
  maintenance?: MaintenanceConfig;
  stages?: StagesConfig;
}

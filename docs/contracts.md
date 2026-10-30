# Package contracts

The public API each package must expose so that the others integrate. Signatures are authoritative; implementations may add more exports. Types come from `@hypdriv/core` unless stated. All stages are `Stage` objects from `@hypdriv/core` (`{ name, pre?, post?, edgeOnly? }`) and use `ctx.state` keys exported from the package that owns them.

## Shared state keys (`ctx.state`)

| Key (export) | Package | Type | Written by |
| --- | --- | --- | --- |
| `NONCE_KEY` | security | `string` | csp stage (nonce mode) |
| `CSP_MODE_KEY` | security | `'nonce' \| 'hash' \| 'report-only' \| 'off'` | csp stage |
| `CSP_EXTRA_HASHES_KEY` | security | `string[]` (`'sha256-…'` source expressions) | stages that inject deterministic inline scripts at the edge (speculation, theme); merged into `script-src` by csp stage in hash mode |
| `RATE_LIMIT_KEY` | security | `{ policy: string; remaining: number; limit: number; reset: number }[]` | rate-limit stage |
| `BOT_KEY` | security | `{ verdict: 'human' \| 'verified' \| 'likely' \| 'definite'; score?: number; reason: string }` | bots stage |
| `CACHE_DECISION_KEY` | cache | `CacheDecision` | edge-cache stage |
| `FLAGS_KEY` | flags | `Record<string, FlagValue>` | flags stage |
| `GEO_KEY` | next (stages) | `GeoInfo` | geo stage |
| `LOCALE_KEY` | next (stages) | `string` | i18n stage |
| `THEME_KEY` | purser | `Record<string, string>` (axis → value) | theme stage |
| `TRACE_KEY` | observe | `{ traceId: string; spanId: string; sampled: boolean }` | request-id stage |

## `@hypdriv/cache`

```ts
export interface CacheStore {
  name: string;
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface CacheEntry { response: Response; meta: CacheMeta }
export interface CacheMeta { key: string; storedAt: number; ttl: number; swr: number; staleIfError: number; tags: string[]; buildId: string; policyId: string; vary: string[]; status: number }
export function createMemoryStore(options?: { maxEntries?: number; maxBytes?: number }): CacheStore;
export function createCacheApiStore(options?: { cache?: CacheLike; cacheName?: string; keyOrigin?: string }): CacheStore;   // Workers Cache API
export function createKvStore(kv: KVNamespaceLike, options?: { prefix?: string; maxBytes?: number }): CacheStore;
export function createTieredStore(stores: CacheStore[]): CacheStore;
export function selectStore(kind: CacheStoreKind, caps: Capabilities, env: HypDrivEnv, config: ResolvedConfig): CacheStore;

export interface TagIndex { add(key: string, tags: string[], ttl: number): Promise<void>; keysFor(tags: string[]): Promise<string[]>; remove(keys: string[]): Promise<void> }
export function createMemoryTagIndex(): TagIndex;
export function createKvTagIndex(kv: KVNamespaceLike, options?: { prefix?: string }): TagIndex;

export interface CacheKeyInput { request: Request; url: URL; policy: ResolvedEdgeCachePolicy; buildId: string; geo?: GeoProperties; flags?: Record<string, FlagValue>; locale?: string; device?: string; trailingSlash: boolean | null; ignoredQuery: string[] }
export function buildCacheKey(input: CacheKeyInput): Promise<{ key: string; vary: string[]; url: string }>;

export type CacheStatus = 'HIT' | 'MISS' | 'STALE' | 'BYPASS' | 'REVALIDATED' | 'ERROR-STALE' | 'DYNAMIC' | 'NEGATIVE';
export interface CacheDecision { status: CacheStatus; reason: string; policy?: ResolvedEdgeCachePolicy; key?: string; age?: number; tags?: string[] }
export const CACHE_DECISION_KEY: StateKey<CacheDecision>;

export function resolvePolicies(config: ResolvedConfig, manifest: HypManifest): ResolvedEdgeCachePolicy[];   // explicit + inferred, ordered
export function matchPolicy(policies: ResolvedEdgeCachePolicy[], ctx: HypContext): ResolvedEdgeCachePolicy | null;
export interface EdgeCacheOptions { store: CacheStore; tagIndex?: TagIndex; purger?: Purger; now?: () => number }
export interface Purger { purgeTags(tags: string[]): Promise<void>; purgeUrls(urls: string[]): Promise<void> }
export function createZonePurger(options: { zoneId: string; token: string; fetch?: typeof fetch }): Purger;
export function createEdgeCache(options: EdgeCacheOptions): EdgeCache;
export interface EdgeCache { stage(): Stage /* name 'edge-cache' */; purgeTags(tags: string[]): Promise<number>; purgeUrls(urls: string[]): Promise<number>; store: CacheStore }
export function cacheControlFor(policy: ResolvedEdgeCachePolicy): string;   // `public, s-maxage=…, stale-while-revalidate=…`
```

Behaviour: see architecture §6. The stage must: match a policy (`ctx.route` + config), skip non-GET/HEAD, honour bypass, build the key, coalesce misses, serve stale + revalidate in `ctx.waitUntil`, stale-if-error on 5xx/throw, negative-cache 404/410, set `x-hypdriv-cache`, `Cache-Tag`, `Age`, `Server-Timing` (`cache;desc=HIT`), and respect origin `Cache-Control: no-store|private` when `respectOrigin`.

## `@hypdriv/security`

```ts
// CSP
export interface CspBuildInput { config: ResolvedCsp; mode: 'nonce' | 'hash'; nonce?: string; hashes?: { scriptHashes: string[]; styleHashes: string[] }; extraScriptHashes?: string[]; development: boolean; reportTo?: string | null; origin?: string | null }
export function buildCspHeader(input: CspBuildInput): string;          // serialised policy
export function mergeDirectives(...sets: CspDirectives[]): CspDirectives;
export function serializeCsp(directives: CspDirectives): string;
export function parseCsp(header: string): CspDirectives;
export function cspStage(config: ResolvedConfig): Stage;               // name 'csp'; decides mode from ctx.route.classification + manifest.csp
export const NONCE_KEY: StateKey<string>; export const CSP_MODE_KEY: StateKey<'nonce' | 'hash' | 'report-only' | 'off'>;
export function cspReportHandler(options: { sink: (report: CspReport) => void | Promise<void>; maxBytes?: number }): (request: Request) => Promise<Response>;
export function suggestPolicy(reports: CspReport[], current: CspDirectives): { directives: CspDirectives; additions: Array<{ directive: string; source: string; count: number }> };

// Headers
export function buildSecurityHeaders(config: ResolvedSecurityHeaders, options: { development: boolean; https: boolean; pathname: string }): Record<string, string>;
export function securityHeadersStage(config: ResolvedConfig): Stage;   // name 'security-headers'
export function serializePermissionsPolicy(policy: Record<string, string[]>): string;

// Rate limiting
export interface CounterStore { increment(key: string, windowSeconds: number, now: number): Promise<{ count: number; resetAt: number }>; /* fixed window */
  slidingCount?(key: string, windowSeconds: number, now: number): Promise<{ count: number; resetAt: number }>;
  takeToken?(key: string, capacity: number, refillPerSecond: number, now: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }> }
export function createMemoryCounterStore(): CounterStore;
export function createCacheApiCounterStore(options?: { cache?: CacheLike; keyOrigin?: string }): CounterStore;  // approximate
export function createKvCounterStore(kv: KVNamespaceLike): CounterStore;
export interface RateLimiter { check(policy: ResolvedRateLimitPolicy, key: string, now?: number): Promise<RateLimitResult> }
export interface RateLimitResult { allowed: boolean; limit: number; remaining: number; resetAt: number; retryAfter: number }
export function createRateLimiter(options: { store: CounterStore; binding?: RateLimitBindingLike }): RateLimiter;
export function rateLimitHeaders(result: RateLimitResult, policyId: string): Record<string, string>;   // RateLimit, RateLimit-Policy, Retry-After
export function rateLimitStage(config: ResolvedConfig, limiter: RateLimiter): Stage;   // name 'rate-limit'
export function resolveRateLimitKey(policy: ResolvedRateLimitPolicy, ctx: HypContext): string;
export const RATE_LIMIT_KEY: StateKey<Array<{ policy: string; remaining: number; limit: number; reset: number }>>;

// Bots & shield & csrf
export function classifyRequest(ctx: HypContext, config: ResolvedBots): { verdict: 'human' | 'verified' | 'likely' | 'definite'; score?: number; reason: string };
export function botsStage(config: ResolvedConfig, options?: { turnstileVerify?: (token: string, ip: string) => Promise<boolean> }): Stage; // name 'bots'
export function shieldStage(config: ResolvedConfig): Stage;            // name 'shield'
export function csrfStage(config: ResolvedConfig): Stage;              // name 'csrf' (runs for unsafe methods on matched routes)
export function issueCsrfToken(secret: string, sessionId?: string): Promise<string>;
export function verifyCsrfToken(secret: string, token: string, sessionId?: string): Promise<boolean>;
export function verifyTurnstile(secret: string, token: string, ip?: string, fetchImpl?: typeof fetch): Promise<{ success: boolean; errorCodes: string[] }>;

// Server functions
export function safeAction<Input, Output>(definition: SafeActionDefinition<Input, Output>): SafeActionHandler<Input, Output>;  // Standard Schema input; result { ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }
export class ActionError extends Error { code: string; status: number; fieldErrors?: Record<string, string[]> }
export function defineRoute<Query, Body, Output>(definition: RouteDefinition<Query, Body, Output>): (request: Request, context?: unknown) => Promise<Response>;

// Sessions & crypto (all WebCrypto)
export function createSessionStore<T extends object>(options: { secret: string | string[]; cookie?: string; ttlSeconds?: number; sliding?: boolean; sameSite?: 'lax' | 'strict' | 'none'; secure?: boolean; path?: string; domain?: string }): SessionStore<T>;
export interface SessionStore<T> { read(headers: Headers): Promise<{ data: T | null; expiresAt: number | null; needsRefresh: boolean }>; write(data: T, options?: { ttlSeconds?: number }): Promise<string /* Set-Cookie */>; clear(): string }
export function encrypt(secret: string, plaintext: string | Uint8Array, aad?: string): Promise<string>;   // v1.<kid>.<iv>.<ct> base64url
export function decrypt(secrets: string | string[], token: string, aad?: string): Promise<Uint8Array | null>;
export const jwt: { sign(payload: object, key: string | CryptoKey, options: { alg: 'HS256' | 'ES256' | 'RS256'; expiresIn?: number; issuer?: string; audience?: string; kid?: string }): Promise<string>;
                    verify(token: string, keyOrJwks: string | CryptoKey | { jwksUrl: string } | JsonWebKey[], options?: { algorithms?: string[]; issuer?: string; audience?: string; clockTolerance?: number; fetch?: typeof fetch }): Promise<{ payload: Record<string, unknown>; header: Record<string, unknown> }>;
                    decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null };
export const signing: { signUrl(url: URL | string, secret: string, options?: { expiresIn?: number; param?: string }): Promise<string>; verifyUrl(url: URL | string, secret: string, options?: { param?: string }): Promise<boolean>;
                        signValue(value: string, secret: string): Promise<string>; verifyValue(signed: string, secret: string): Promise<string | null>;
                        signInternalRequest(request: Request, secret: string, now?: number): Promise<Request>; verifyInternalRequest(request: Request, secret: string, options?: { ttlSeconds?: number; now?: number }): Promise<boolean> };
export const webhooks: { verifyStripe(payload: string, header: string, secret: string, toleranceSeconds?: number): Promise<boolean>; verifyGitHub(payload: string, signature256: string, secret: string): Promise<boolean>; verifyStandard(payload: string, headers: { id: string; timestamp: string; signature: string }, secret: string, toleranceSeconds?: number): Promise<boolean> };
export const passwords: { hash(password: string, options?: { cost?: number }): Promise<string>; verify(password: string, phc: string): Promise<boolean>; needsRehash(phc: string): boolean };
export function safeRedirect(target: string | URL, options: { origin: string; allowHosts?: string[]; fallback?: string }): string;
export function deviceClass(headers: Headers): 'mobile' | 'desktop' | 'bot';
```

`@hypdriv/security/node`: `scanSecrets({ dirs, patterns, env, publicPrefixes, envAllowlist, minValueLength }): Promise<SecretFinding[]>` and `formatFindings()`.

## `@hypdriv/observe`

```ts
export interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; start: number; end?: number; attributes: Record<string, string | number | boolean>; events: Array<{ name: string; time: number; attributes?: Record<string, string | number | boolean> }>; status: 'unset' | 'ok' | 'error'; setAttribute(k, v): void; addEvent(name, attrs?): void; setStatus(status, message?): void; end(): void }
export interface SpanExporter { export(spans: Span[]): Promise<void> }
export function createTracer(options: { serviceName: string; exporter: SpanExporter; sampleRate?: number; resource?: Record<string, string> }): Tracer;
export interface Tracer { startSpan(name: string, options?: { parent?: Span | string /* traceparent */; attributes?: ... }): Span; withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, options?): Promise<T>; flush(): Promise<void>; traceparent(span: Span): string }
export function parseTraceparent(value: string | null): { traceId: string; parentId: string; sampled: boolean } | null;
export function consoleExporter(): SpanExporter; export function otlpHttpExporter(options: { url: string; headers?: Record<string, string>; timeoutMs?: number; fetch?: typeof fetch }): SpanExporter; export function analyticsEngineExporter(binding: AnalyticsEngineLike, dataset?: string): SpanExporter; export function noopExporter(): SpanExporter;
export function createLogger(config: ResolvedObserve['logging'], fields?: LogFields): Logger;   // extends core console logger with redaction list & sampling
export function requestIdStage(config: ResolvedConfig, tracer?: Tracer): Stage;   // name 'request-id': ids, traceparent, logger child, TRACE_KEY, x-request-id + Server-Timing in post
export function observeStage(config: ResolvedConfig, options: { tracer?: Tracer; vitalsSink?: VitalsSink }): Stage;   // name 'observe': request summary log, span end, flush in waitUntil
export const TRACE_KEY: StateKey<{ traceId: string; spanId: string; sampled: boolean }>;
export interface VitalsPayload { name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB'; value: number; rating: 'good' | 'needs-improvement' | 'poor'; id: string; route?: string; pathname: string; navigationType?: string; attribution?: Record<string, unknown>; buildId?: string; cache?: string; ts: number }
export interface VitalsSink { write(payload: VitalsPayload, ctx: { ip?: string; country?: string; ua?: string }): void | Promise<void> }
export function logVitalsSink(log: Logger): VitalsSink; export function analyticsEngineVitalsSink(binding: AnalyticsEngineLike): VitalsSink;
export function vitalsHandler(options: { sink: VitalsSink; sampleRate?: number; maxBytes?: number; allowOrigin?: string }): (request: Request, ctx?: { ip?: string; country?: string }) => Promise<Response>;
export function serverTimingMode(config: ResolvedConfig, development: boolean): ServerTimingMode;
export function onRequestError(options: { tracer?: Tracer; log: Logger; sink: ... }): (error: unknown, request: { path: string; method: string; headers: Record<string, string> }, context: { routerKind: string; routePath: string; routeType: string; renderSource?: string; revalidateReason?: string }) => Promise<void>;   // Next's instrumentation signature
```

`@hypdriv/observe/client`: `reportVitals(options: { endpoint?: string; sampleRate?: number; attribution?: boolean; extra?: () => Record<string, unknown> }): () => void` (uses `web-vitals` when installed, falls back to PerformanceObserver), `readServerTiming(): TimingEntry[]` (from navigation entry), `readHypDrivHeaders()`.

## `@hypdriv/flags`

```ts
export interface FlagEvalInput { definitions: Record<string, FlagDefinition>; stableId: string; url: URL; headers: Headers; cookies: Record<string, string>; geo?: GeoProperties; device?: 'mobile' | 'desktop' | 'bot'; now?: Date; overrides?: Record<string, FlagValue> }
export function evaluateFlags(input: FlagEvalInput): { values: Record<string, FlagValue>; reasons: Record<string, string> };
export interface FlagProvider { load(): Promise<Record<string, FlagDefinition>>; subscribe?(cb: () => void): () => void }
export function staticProvider(defs): FlagProvider; export function envProvider(env: HypDrivEnv, envVar: string, fallback: defs): FlagProvider; export function kvProvider(kv: KVNamespaceLike, key: string, fallback: defs, refreshSeconds: number): FlagProvider; export function openFeatureProvider(client: { getBooleanValue(k, d, ctx?): Promise<boolean>; getStringValue; getNumberValue }, defs): FlagProvider;
export function flagsStage(config: ResolvedConfig, provider: FlagProvider): Stage;   // name 'flags': ensures id cookie (Set-Cookie in post if missing), evaluates, sets FLAGS_KEY + request header (encoded) + Vary note
export function encodeFlagsHeader(values: Record<string, FlagValue>): string; export function decodeFlagsHeader(value: string | null): Record<string, FlagValue>;
export const FLAGS_KEY: StateKey<Record<string, FlagValue>>;
export function flagsFromHeaders(headers: Headers, headerName?: string): Record<string, FlagValue>;
```
`@hypdriv/flags/react`: `FlagsProvider({ values, children })`, `useFlag(name, fallback?)`, `useFlags()`, `<Flag name fallback>` (renders children when truthy).

## `@hypdriv/live`

```ts
export class HypDrivChannel /* DurableObject with SQLite, hibernation */ { fetch(request): Promise<Response> /* GET ?channel= → SSE | Upgrade → WS; POST /publish */ ; webSocketMessage/webSocketClose handlers }
export function createLiveHandler(config: ResolvedConfig, env: HypDrivEnv): (request: Request, ctx: { waitUntil; authorize? }) => Promise<Response>;   // routes /_hypdriv/live/:channel to the DO or polling fallback
export function publish(env: HypDrivEnv, channel: string, event: { type: string; data?: unknown; id?: string }, options?: { binding?: string }): Promise<{ delivered: boolean; transport: 'durable-object' | 'none' }>;
export interface LiveEvent { id: string; type: string; data: unknown; ts: number }
```
`@hypdriv/live/react`: `useLive(channel, options?: { onEvent, transport, path, enabled })` → `{ status: 'connecting' | 'open' | 'closed' | 'error'; lastEvent; events }`, `useLiveValue(channel, initial)`, `useLiveRefresh(channel)` (calls `router.refresh()` from `next/navigation` when available via injected callback option), `LiveProvider`.
`@hypdriv/live/durable-object`: re-export of the class for the Worker entry.

## `@hypdriv/image`

`@hypdriv/image/loader`: `default function cloudflareLoader({ src, width, quality }): string` (next.js `loaderFile` contract; uses `/cdn-cgi/image/width=,quality=,format=auto/<src>` when `globalThis.__HYPDRIV_IMAGE_CDN_CGI__ !== false`; reads a global config object set by `withHypDriv`), `buildCdnCgiUrl(options)`, `buildNextImageUrl()`.
`@hypdriv/image/react`: `HypImage` (wraps `next/image`, injects `placeholder="blur"` + `blurDataURL` from a placeholders map, sensible `sizes` defaults), `withPlaceholders(map)`.
`@hypdriv/image/node`: `generatePlaceholders({ projectDir, sources, size, file })` using `sharp` when available (dynamic import), else skips with a diagnostic; writes `.hypdriv/placeholders.json`.

## `@hypdriv/purser`

```ts
// runtime (neutral)
export const THEME_KEY: StateKey<Record<string, string>>;
export function resolveTheme(config: ResolvedPurser['theme'], input: { cookies: Record<string, string>; headers: Headers }): { values: Record<string, string>; classes: string[] };
export function buildThemeScript(theme: ResolvedPurser['theme']): string;   // inline fallback script (deterministic, hashable)
export function themeStage(config: ResolvedConfig): Stage;   // name 'theme': pre computes THEME_KEY + Accept-CH/Vary headers; post pins classes on <html> via HTMLRewriter when available (edge), else no-op
export function layerStatement(options: { layers: { tokens; globals; atoms }; before?: string[]; after?: string[] }): string;
export function extractAtomClasses(css: string, prefix: string): Set<string>;        // class names declared in a Purser stylesheet
export function extractHtmlClasses(html: string, prefix: string): Set<string>;      // Purser classes referenced by HTML
export function verifyAtoms(input: { html: Record<string /*routeId*/, string>; css: string; prefix: string }): { missing: Record<string, string[]>; used: Record<string, string[]>; unused: string[] };
// node
export function createPurserBridge(options: { projectDir: string; config: ResolvedPurser; log?: Logger }): Promise<PurserBridge>;   // detects @avonao/purser and TS version; throws HypDrivError E_UNSUPPORTED with install hint when missing
export interface PurserBridge { build(): Promise<BuildResult>; check(): Promise<BuildResult>; watch(onResult: (r: BuildResult) => void): Promise<{ close(): void }>; outFile: string | null; tokensFile: string | null; writeDevDiagnostics(result: BuildResult): Promise<void> /* .hypdriv/dev/purser.json */ }
export function detectPurser(projectDir: string): { installed: boolean; version: string | null; typescriptVersion: string | null; typescriptCompatible: boolean; tokensFile: string | null }
export function auditOverrides(options: { urls: string[]; widths: number[]; states: ('default'|'hover'|'focus')[]; chromePath?: string; strikeScript?: string; timeoutMs?: number }): Promise<AuditReport>;   // launches Chrome with --remote-debugging-port, drives it over CDP with Node's WebSocket, evaluates Purser's strike-count.js
```

## `@hypdriv/next`

```ts
// config
export function withHypDriv(nextConfig?: NextConfig | ((phase: string, ctx: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>), options?: WithHypDrivOptions): (phase: string, ctx: { defaultConfig: NextConfig }) => Promise<NextConfig>;
export interface WithHypDrivOptions { config?: HypDrivConfig; configFile?: string | false; adapter?: string; purser?: boolean; safeDefaults?: boolean; projectDir?: string }
// adapter
export function createAdapter(options?: { baseAdapter?: string }): NextAdapter;  export default adapter (the module Next imports via adapterPath)
export function buildManifest(input: AdapterBuildInput): Promise<HypManifest>;   // pure derivation from onBuildComplete context + fs reads; unit-tested with fixtures
// proxy
export function createProxy(config: HypDrivConfig | ResolvedConfig, stages?: Stage[] | ((defaults: Stage[]) => Stage[]), options?: { manifest?: HypManifest; projectDir?: string; platform?: Partial<Platform> }): (request: NextRequest, event: NextFetchEvent) => Promise<Response>;
export const matcher: { matcher: string[] };   // recommended `config` export
export { stages } // namespace of factories: requestId, maintenance, shield, bots, rateLimit, geo, i18n, flags, redirects, theme, edgeCache, csp, securityHeaders, earlyHints, speculation, skew, observe, custom(fn)
// stages (neutral)
export interface Platform { capabilities: Capabilities; manifest: HypManifest; config: ResolvedConfig; log: Logger; development: boolean; runner: Runner; env: HypDrivEnv; cacheStore?: CacheStore; tagIndex?: TagIndex; purger?: Purger; counterStore?: CounterStore; rateLimitBinding?: RateLimitBindingLike; flagsProvider?: FlagProvider; tracer?: Tracer; vitalsSink?: VitalsSink; turnstileVerify?: ...; kv?: KVNamespaceLike }
export function createPlatform(input: { config: ResolvedConfig; manifest: HypManifest | null; env: HypDrivEnv; runner: Runner; development?: boolean; log?: Logger }): Platform;   // picks stores from capabilities (ADR 0004)
export function buildDefaultStages(platform: Platform): Stage[];   // in DEFAULT_STAGE_ORDER, honouring config.stages
export function geoStage(config): Stage; i18nStage(config): Stage; redirectsStage(config, kv?): Stage; maintenanceStage(config, kv?): Stage; earlyHintsStage(config): Stage; speculationStage(config): Stage /* header/component mode */; skewStage(config): Stage;
export const GEO_KEY, LOCALE_KEY; export function buildSpeculationRules(input: { manifest; config: ResolvedSpeculation; pathname: string }): object | null; export function speculationScriptHash(...)
export function earlyHintsFor(manifest: HypManifest, routeId: string, config: ResolvedPerformance['earlyHints'], purserStylesheet?: string): LinkEntry[];
// server
export function hyp(): Promise<HypServerContext>;   // uses next/headers; fields: requestId, nonce, geo, locale, flags, theme, route, csp, cacheStatus, env (via getCloudflareContext when available), waitUntil(after), log
export function nonce(): Promise<string | undefined>; export function geo(): Promise<GeoInfo>; export function flag<T extends FlagValue>(name: string, fallback?: T): Promise<T>;
export function defer(fn: () => Promise<unknown>): void;   // next/server `after`
export function jobHandler(options: { secretEnv?: string }, handler: (input: { request: Request; job: string; payload: unknown }) => Promise<Response | unknown>): (request: Request) => Promise<Response>;  // verifies internal signature
// cache
export function revalidateTag(tag: string, profile?: Parameters<typeof import('next/cache').revalidateTag>[1]): Promise<void>;  // Next + edge purge
export function revalidatePath(path: string, type?: 'page' | 'layout'): Promise<void>;
export function purgeEdge(options: { tags?: string[]; urls?: string[] }): Promise<void>;
// client
export function Speculation(props: { rules?: object; nonce?: string }): JSX.Element | null; export function HypDrivDevTools(props?): JSX.Element | null /* lazy-loads @hypdriv/devtools */; export { useFlag, FlagsProvider } from '@hypdriv/flags/react'; export function VitalsReporter(props?: { endpoint?: string; sampleRate?: number }): null;
// instrumentation
export function register(options?: {...}): Promise<void>; export function onRequestError(...): ReturnType<...>; export function onRouterTransitionStart(...)
```

## `@hypdriv/cloudflare`

```ts
export function createWorker(options: { config: HypDrivConfig | ResolvedConfig; next: () => Promise<{ default: { fetch(request: Request, env: any, ctx: ExecutionContextLike): Promise<Response> } }>; manifest?: HypManifest | (() => Promise<HypManifest>); stages?: Stage[] | ((defaults: Stage[], platform: Platform) => Stage[]); onError?: (error: Error, request: Request) => Response | Promise<Response>; }): ExportedHandler<HypDrivEnv>;   // fetch/scheduled/queue/email/tail
export function getHypContext(): HypContext | undefined;   // AsyncLocalStorage-backed accessor for server code running inside the Worker
export class HypDrivLimiter /* DO: exact counters (fixed/sliding/token bucket) + single-flight locks */; export class HypDrivIndex /* DO: tag → keys index with SQLite */; export { HypDrivChannel } from '@hypdriv/live/durable-object';
export function createDoCounterStore(ns: DurableObjectNamespaceLike): CounterStore; export function createDoTagIndex(ns): TagIndex;
export function internalRoutes(platform: Platform, options): (request: Request) => Promise<Response | null>;   // /_hypdriv/health, /vitals, /csp-report, /live/*, /dev/* (dev only), /flags (dev only)
export function dispatchScheduled(event: { cron: string; scheduledTime: number }, platform, next): Promise<void>;   // config.jobs.cron → signed internal fetch
export function dispatchQueue(batch: MessageBatch, ...): Promise<void>; export function dispatchEmail(...); export function forwardTail(events, sinks)
export function edgeStages(platform: Platform): Stage[];   // edge-only: speculation injection (HTMLRewriter), theme pin, html-transforms, priority hints; appended/merged into defaults
export function cloudflareGeo(cf: Record<string, unknown> | undefined): GeoProperties;
```

## `@hypdriv/devtools`

`HypDrivDevTools(props: { position?; hotkey?; endpoint?; initialOpen? })` client component: reads `performance.getEntriesByType('navigation')[0].serverTiming`, Web Vitals (via `@hypdriv/observe/client`), `x-hypdriv-*` info exposed through `<meta name="hypdriv:*">` tags optionally rendered by `hyp()` helpers, and polls `endpoint` (`/_hypdriv/dev/state`, `/_hypdriv/dev/purser`) when available. No dependency on Next; pure React 19.

## `@hypdriv/testing`

`createFakeKV()`, `createFakeDurableObjectNamespace(factory)`, `createFakeQueue()`, `createFakeAnalyticsEngine()`, `createFakeCache()` (CacheLike), `createTestContext(overrides)` (HypContext), `runStage(stage, ctx, next?)`, `requestWithCf(url, init, cf)`, `expectHeaders(response, expected)`, `collectSetCookies(response)`, `withEnv(env, fn)`. `@hypdriv/testing/vitest`: `hypdrivVitestProject(name, options)` helpers returning vitest project configs for Node and Workers.

## `@hypdriv/cli`

Commands and flags per architecture §10. Implementation notes: `src/commands/<name>.ts` each exporting `run(args: ParsedArgs, io: IO): Promise<number>`; shared `src/ui.ts` (colours, tables, spinners without deps), `src/args.ts` (`node:util.parseArgs`), `src/project.ts` (detection: Next version, OpenNext, wrangler config, Purser, TS, package manager). `init` must be idempotent and never destroy user files (backups as `*.hypdriv.bak` before edits). `doctor` checks are objects `{ id, title, severity, run(ctx): Promise<CheckResult>, fix?(ctx) }` in `src/doctor/checks/*.ts` (at least 40 checks across: environment, next config, adapter, proxy, wrangler/compat, workers API usage scan, bundle size vs limits, env leaks, headers posture (reads manifest), purser, dependencies freshness). `analyze` implements source-map attribution (VLQ decode) in `src/analyze/sourcemap.ts`.

## `create-hypdriv`

Interactive-free when flags are passed: `create-hypdriv <dir> [--purser] [--pm pnpm] [--template basic|with-purser]`. Copies `templates/*` bundled in the package, runs the package manager install, prints next steps. Templates are complete Next 16 + OpenNext + HypDriv apps (same content as `examples/`).

## `hypdriv` (umbrella)

Re-exports: `.` → `@hypdriv/core` + `defineConfig`; `./config` → `withHypDriv`; `./next` → `@hypdriv/next`; `./cloudflare` → `@hypdriv/cloudflare`; `./server` → `@hypdriv/next/server` + security server APIs; `./client` → `@hypdriv/next/client`. `bin/hypdriv.js` imports `@hypdriv/cli/bin`.

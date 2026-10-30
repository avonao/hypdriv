import { bypassReason, effectiveTags, matchPolicy, resolvePolicies } from '@hypdriv/cache';
import {
  appendListHeader,
  createContext,
  createRouteMatcher,
  defineStage,
  emptyManifest,
  FLAGS_COOKIE_PENDING_KEY,
  getSetCookies,
  HEADER,
  type HypContext,
  type HypManifest,
  type Logger,
  parseCacheControl,
  type ResolvedConfig,
  type ResolvedEdgeCachePolicy,
  type RouteMatcher,
  type Stage,
  type StateKey,
  stateKey,
} from '@hypdriv/core';
import { MAX_TAGS_PER_RESPONSE, pathTag, routeTag, sanitizeTags } from './tags';
import { type ConfigInput, readBuildManifest, resolveInput, warnOnce } from './util';

/** Response header Vercel's CDN reads first (consumed by Vercel, never forwarded to clients). */
export const VERCEL_CDN_CACHE_CONTROL = 'vercel-cdn-cache-control';
/** Targeted cache header for Vercel and CDNs in front of it (RFC 9213). */
export const CDN_CACHE_CONTROL = 'cdn-cache-control';
/** Comma-separated cache tags of a response, used by Vercel's tag purge. */
export const VERCEL_CACHE_TAG = 'vercel-cache-tag';

/** Longest lifetime Vercel's CDN accepts for `s-maxage` / `stale-while-revalidate` (one year). */
export const MAX_CDN_SECONDS = 31_536_000;

/** Statuses Vercel's CDN caches. */
export const VERCEL_CACHEABLE_STATUSES: ReadonlySet<number> = new Set([200, 301, 302, 307, 308, 404, 410]);

/** Outcome of the Vercel CDN stage: `CDN` (headers emitted), `BYPASS` (policy matched, not cacheable), `DYNAMIC`. */
export type CdnStatus = 'CDN' | 'BYPASS' | 'DYNAMIC';

/** The CDN decision for one request (`ctx.state.get(CDN_DECISION_KEY)`). */
export interface CdnDecision {
  status: CdnStatus;
  /** Machine-readable detail: `policy`, `negative`, `no-policy`, `cookie:session`, `vary:flags`, `uncacheable:set-cookie`… */
  reason: string;
  policy?: ResolvedEdgeCachePolicy;
  /** The `Vercel-CDN-Cache-Control` value (status `CDN`). */
  cacheControl?: string;
  tags?: string[];
  vary?: string[];
}

/**
 * Written by the Vercel CDN stage for every request. `@hypdriv/cache`'s `CacheStatus` has no `CDN` member,
 * so the decision lives under its own key; the `cache` Server-Timing marker carries the same status.
 */
export const CDN_DECISION_KEY: StateKey<CdnDecision> = stateKey<CdnDecision>('vercel.cdn.decision');

/** Everything needed to finalise the CDN headers once the response is known. */
export interface CdnPlan {
  ttl: number;
  swr: number;
  staleIfError: number;
  negativeTtl: number;
  statuses: number[];
  respectOrigin: boolean;
  tags: string[];
  vary: string[];
  /** Also emit `CDN-Cache-Control` for CDNs in front of Vercel. */
  downstream: boolean;
}

const PLAN_KEY = stateKey<CdnPlan>('vercel.cdn.plan');

/** Vercel request headers carrying the geo dimensions HypDriv policies can vary on. */
const GEO_VARY: Record<string, string | null> = {
  country: 'X-Vercel-IP-Country',
  region: 'X-Vercel-IP-Country-Region',
  city: 'X-Vercel-IP-City',
  continent: 'X-Vercel-IP-Continent',
  timezone: 'X-Vercel-IP-Timezone',
  // Vercel's CDN cache is segmented by region already.
  colo: null,
};

function clampSeconds(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(MAX_CDN_SECONDS, Math.max(min, Math.floor(value)));
}

/** `s-maxage=<ttl>[, stale-while-revalidate=<swr>][, stale-if-error=<sie>]` for Vercel's CDN. */
export function cdnCacheControl(lifetime: { ttl: number; swr?: number; staleIfError?: number }): string {
  const parts = [`s-maxage=${clampSeconds(lifetime.ttl, 1)}`];
  const swr = clampSeconds(lifetime.swr ?? 0, 0);
  const sie = clampSeconds(lifetime.staleIfError ?? 0, 0);
  if (swr > 0) parts.push(`stale-while-revalidate=${swr}`);
  if (sie > 0) parts.push(`stale-if-error=${sie}`);
  return parts.join(', ');
}

/**
 * Whether a policy can be expressed with Vercel's CDN, which keys entries by URL plus `Vary` request headers
 * only. Cookie- and flag-dependent variants and cookie/predicate bypasses cannot be represented (`Vary: Cookie`
 * makes a response uncacheable on Vercel, and a cached entry would otherwise be served to requests that should
 * bypass it). Bypass *headers* become `Vary` entries so those requests get separate, never-stored entries;
 * bypass query parameters are already part of the cache key.
 */
export function cdnExpressibility(
  policy: ResolvedEdgeCachePolicy,
  config: ResolvedConfig,
): { ok: true; vary: string[] } | { ok: false; reason: string } {
  if (policy.vary.cookies.length) return { ok: false, reason: 'vary:cookies' };
  if (policy.vary.flags.length) return { ok: false, reason: 'vary:flags' };
  if (policy.bypass.cookies.length) return { ok: false, reason: 'bypass:cookies' };
  if (policy.bypass.when) return { ok: false, reason: 'bypass:when' };
  const headers = policy.vary.headers.map((h) => h.toLowerCase());
  if (headers.includes('cookie')) return { ok: false, reason: 'vary:cookie' };
  if (headers.includes('*')) return { ok: false, reason: 'vary:*' };
  if (policy.vary.language && config.i18n?.strategy === 'cookie')
    return { ok: false, reason: 'vary:language-cookie' };

  const vary: string[] = [...policy.vary.headers];
  for (const name of policy.bypass.headers) if (name.toLowerCase() !== 'authorization') vary.push(name);
  for (const dimension of policy.vary.geo) {
    const header = GEO_VARY[dimension];
    if (header) vary.push(header);
  }
  if (policy.vary.language) {
    vary.push('Accept-Language');
    // Without Accept-Language, HypDriv's negotiation falls back to the visitor's country.
    if (config.i18n && Object.keys(config.i18n.geoMap).length) vary.push('X-Vercel-IP-Country');
  }
  // HypDriv's device class uses the client hint and falls back to the user agent (Safari and Firefox send no
  // hints), so both must key the entry or mobile and desktop variants would be mixed up.
  if (policy.vary.device) vary.push('Sec-CH-UA-Mobile', 'User-Agent');
  const seen = new Set<string>();
  return {
    ok: true,
    vary: vary.filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/** Writes the CDN headers of a plan onto `headers`. */
export function writeCdnHeaders(
  headers: Headers,
  cacheControl: string,
  plan: Pick<CdnPlan, 'tags' | 'downstream'>,
): void {
  headers.set(VERCEL_CDN_CACHE_CONTROL, cacheControl);
  if (plan.downstream) headers.set(CDN_CACHE_CONTROL, cacheControl);
  if (plan.tags.length) headers.set(VERCEL_CACHE_TAG, plan.tags.join(','));
}

/** Removes the CDN headers HypDriv writes. */
export function removeCdnHeaders(headers: Headers): void {
  headers.delete(VERCEL_CDN_CACHE_CONTROL);
  headers.delete(CDN_CACHE_CONTROL);
  headers.delete(VERCEL_CACHE_TAG);
}

function seconds(value: string | true | undefined): number | undefined {
  if (value === undefined || value === true) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

/** Final CDN lifetime for a response, or why it must not be cached. */
export type CdnVerdict =
  | { ok: true; cacheControl: string; negative: boolean }
  | { ok: false; reason: string };

/**
 * Decides, once the response is known, whether the planned CDN headers may stay: Vercel-cacheable status
 * within the policy's statuses, negative TTL for 404/410, no `Set-Cookie` (also one still pending from an
 * earlier stage), no `Vary: *` / `Vary: Cookie`, an origin that did not take its own CDN decision, and,
 * with `respectOrigin`, the origin's `Cache-Control` (`no-store`, `private`, `no-cache`, shorter lifetimes).
 */
export function cdnVerdict(
  plan: CdnPlan,
  response: Response,
  options: { pendingSetCookie?: boolean } = {},
): CdnVerdict {
  const status = response.status;
  if (!VERCEL_CACHEABLE_STATUSES.has(status) || !plan.statuses.includes(status))
    return { ok: false, reason: `status:${status}` };
  if (options.pendingSetCookie || getSetCookies(response.headers).length)
    return { ok: false, reason: 'set-cookie' };
  const vary = (response.headers.get('vary') ?? '').split(',').map((v) => v.trim().toLowerCase());
  if (vary.includes('*')) return { ok: false, reason: 'vary:*' };
  if (vary.includes('cookie')) return { ok: false, reason: 'vary:cookie' };
  if (response.headers.has(VERCEL_CDN_CACHE_CONTROL) || response.headers.has(CDN_CACHE_CONTROL))
    return { ok: false, reason: 'origin:cdn-cache-control' };

  let ttl = plan.ttl;
  let swr = plan.swr;
  let sie = plan.staleIfError;
  const negative = status === 404 || status === 410;
  if (negative) {
    if (plan.negativeTtl <= 0) return { ok: false, reason: 'negative-disabled' };
    ttl = plan.negativeTtl;
    swr = 0;
    sie = 0;
  }
  if (plan.respectOrigin) {
    const cc = parseCacheControl(response.headers.get('cache-control'));
    if (cc['no-store']) return { ok: false, reason: 'origin:no-store' };
    if (cc.private) return { ok: false, reason: 'origin:private' };
    if (cc['no-cache']) return { ok: false, reason: 'origin:no-cache' };
    const originTtl = seconds(cc['s-maxage']) ?? seconds(cc['max-age']);
    if (originTtl !== undefined) {
      if (originTtl <= 0) return { ok: false, reason: 'origin:max-age=0' };
      ttl = Math.min(ttl, originTtl);
    }
    const originSwr = seconds(cc['stale-while-revalidate']);
    if (originSwr !== undefined) swr = Math.min(swr, originSwr);
    const originSie = seconds(cc['stale-if-error']);
    if (originSie !== undefined) sie = Math.min(sie, originSie);
    if (cc['must-revalidate'] || cc['proxy-revalidate']) {
      swr = 0;
      sie = 0;
    }
  }
  if (ttl < 1) return { ok: false, reason: 'zero-ttl' };
  return { ok: true, cacheControl: cdnCacheControl({ ttl, swr, staleIfError: sie }), negative };
}

/** Options of `vercelCdnStage` and `withVercelCdn`. */
export interface VercelCdnOptions {
  /** Also emit `CDN-Cache-Control` for CDNs in front of Vercel (default `config.vercel.cdn.downstream`). */
  downstream?: boolean;
}

/** Shared planning state of one stage / handler wrapper instance. */
interface Planner {
  plan(ctx: HypContext): { decision: CdnDecision; plan?: CdnPlan };
}

function createPlanner(config: ResolvedConfig, downstream: boolean): Planner {
  const edge = config.cache.edge!;
  const byManifest = new WeakMap<HypManifest, ResolvedEdgeCachePolicy[]>();
  const policiesFor = (manifest: HypManifest) => {
    let policies = byManifest.get(manifest);
    if (!policies) {
      policies = resolvePolicies(config, manifest);
      byManifest.set(manifest, policies);
    }
    return policies;
  };
  const warnUnexpressible = (log: Logger, policy: ResolvedEdgeCachePolicy, reason: string) =>
    warnOnce(
      log,
      `vercel-cdn:${policy.id}:${reason}`,
      `vercel-cdn: edge-cache policy "${policy.id}" cannot be expressed on Vercel's CDN (${reason}); its responses are not CDN-cached`,
      { policy: policy.id, reason },
    );

  return {
    plan(ctx) {
      const method = ctx.request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD')
        return { decision: { status: 'DYNAMIC', reason: `method:${method}` } };
      const policy = matchPolicy(policiesFor(ctx.manifest), ctx);
      if (!policy) return { decision: { status: 'DYNAMIC', reason: 'no-policy' } };
      if (!policy.methods.includes(method))
        return { decision: { status: 'DYNAMIC', reason: `method:${method}`, policy } };
      const expressible = cdnExpressibility(policy, config);
      if (!expressible.ok) {
        warnUnexpressible(ctx.log, policy, expressible.reason);
        return { decision: { status: 'BYPASS', reason: expressible.reason, policy } };
      }
      // A request `Cache-Control: no-cache` is the CDN's business (synchronous revalidation), not a bypass.
      const bypass = bypassReason(policy, ctx);
      if (bypass && bypass !== 'no-cache') return { decision: { status: 'BYPASS', reason: bypass, policy } };
      if (policy.ttl < 1) return { decision: { status: 'BYPASS', reason: 'zero-ttl', policy } };

      const tags = sanitizeTags(
        [
          pathTag(ctx.url.pathname),
          ...(ctx.route ? [routeTag(ctx.route.route.id)] : []),
          ...effectiveTags(policy, ctx.route, ctx.manifest.buildId),
        ],
        MAX_TAGS_PER_RESPONSE,
      );
      const plan: CdnPlan = {
        ttl: clampSeconds(policy.ttl, 1),
        swr: clampSeconds(policy.swr, 0),
        staleIfError: clampSeconds(policy.staleIfError, 0),
        negativeTtl: edge.negativeTtl > 0 ? clampSeconds(edge.negativeTtl, 1) : 0,
        statuses: policy.statuses,
        respectOrigin: policy.respectOrigin,
        tags,
        vary: expressible.vary,
        downstream,
      };
      const cacheControl = cdnCacheControl(plan);
      return {
        decision: { status: 'CDN', reason: 'policy', policy, cacheControl, tags, vary: plan.vary },
        plan,
      };
    },
  };
}

/** `true` when the flags stage will add its bucketing cookie in a later `post`. */
function flagsCookiePending(ctx: HypContext): boolean {
  return ctx.state.get(FLAGS_COOKIE_PENDING_KEY) === true;
}

function record(ctx: HypContext, decision: CdnDecision, debugHeader: boolean): void {
  ctx.state.set(CDN_DECISION_KEY, decision);
  ctx.timings.mark('cache', decision.status);
  if (debugHeader) ctx.responseHeaders.set(HEADER.cache, decision.status);
}

/**
 * The Vercel replacement of the `edge-cache` stage (same name, so `stages.disable`/`stages.order` keep
 * working): instead of storing responses itself it expresses the matched edge-cache policy (explicit or
 * inferred from the manifest) as Vercel CDN headers on `ctx.responseHeaders`:
 *
 * - `Vercel-CDN-Cache-Control: s-maxage=<ttl>[, stale-while-revalidate=<swr>][, stale-if-error=<sie>]`
 *   (plus `CDN-Cache-Control` with the same value when `downstream`),
 * - `Vercel-Cache-Tag`: the policy's effective tags plus `hyp:route:<routeId>` and `hyp:path:<pathname>`
 *   (sanitised, de-duplicated, at most 128),
 * - `Vary` for `vary.headers`, bypass headers, `vary.language` (`Accept-Language`), `vary.geo`
 *   (`X-Vercel-IP-*`) and `vary.device` (`Sec-CH-UA-Mobile`, `User-Agent`).
 *
 * Non-GET/HEAD requests, `Authorization`, bypass cookies/headers/query and policies that Vercel's CDN cannot
 * express (cookie/flag variants, cookie or predicate bypass; warned once per policy) get no CDN headers and a
 * `cache;desc=BYPASS` marker. In `post` the headers are dropped for responses that must not be cached
 * (`Set-Cookie`, uncacheable status, origin `no-store`/`private`) and 404/410 get `cache.edge.negativeTtl`.
 *
 * Returns `null` when `vercel.cdn` or `cache.edge` is disabled.
 *
 * Note: Vercel runs Routing Middleware (`proxy.ts`) before its CDN cache, and documents that middleware cannot
 * set the CDN's caching headers. When this stage runs in `proxy.ts`, the headers reach the client (and
 * `CDN-Cache-Control` reaches CDNs in front of Vercel), but Vercel's own cache follows the function response:
 * wrap Route Handlers with `withVercelCdn()` and emit page headers through `next.config` `headers()`
 * (`vercelCdnRouteHeaders()`).
 */
export function vercelCdnStage(configInput: ConfigInput, options: VercelCdnOptions = {}): Stage | null {
  const config = resolveInput(configInput);
  const cdn = config.vercel.cdn;
  const edge = config.cache.edge;
  if (!cdn || !edge) return null;
  const planner = createPlanner(config, options.downstream ?? cdn.downstream);
  const debugHeader = edge.debugHeader;

  return defineStage({
    name: 'edge-cache',
    runOnRsc: true,
    pre(ctx) {
      const { decision, plan } = planner.plan(ctx);
      if (plan && decision.cacheControl) {
        writeCdnHeaders(ctx.responseHeaders, decision.cacheControl, plan);
        if (plan.vary.length) appendListHeader(ctx.responseHeaders, 'vary', plan.vary);
        ctx.state.set(PLAN_KEY, plan);
      }
      record(ctx, decision, debugHeader);
    },
    post(ctx, response) {
      const decision = ctx.state.get(CDN_DECISION_KEY);
      const plan = ctx.state.get(PLAN_KEY);
      if (decision?.status !== 'CDN' || !plan) return response;
      const pendingSetCookie = getSetCookies(ctx.responseHeaders).length > 0 || flagsCookiePending(ctx);
      const verdict = cdnVerdict(plan, response, { pendingSetCookie });
      if (!verdict.ok) {
        removeCdnHeaders(ctx.responseHeaders);
        record(ctx, { ...decision, status: 'BYPASS', reason: `uncacheable:${verdict.reason}` }, debugHeader);
        return response;
      }
      let tags = plan.tags;
      const originTags = response.headers.get(VERCEL_CACHE_TAG);
      // `ctx.responseHeaders` replaces the response's own tag header on merge: keep the application's tags.
      if (originTags) tags = sanitizeTags([...originTags.split(','), ...plan.tags], MAX_TAGS_PER_RESPONSE);
      writeCdnHeaders(ctx.responseHeaders, verdict.cacheControl, { ...plan, tags });
      if (verdict.cacheControl !== decision.cacheControl || tags !== plan.tags)
        ctx.state.set(CDN_DECISION_KEY, {
          ...decision,
          reason: verdict.negative ? 'negative' : decision.reason,
          cacheControl: verdict.cacheControl,
          tags,
        });
      return response;
    },
  });
}

/** Options of `withVercelCdn`. */
export interface WithVercelCdnOptions extends VercelCdnOptions {
  /**
   * The build manifest, for route tags, the `build:<id>` tag and inferred policies. Default: `.hypdriv/manifest.json`
   * read once from the function's working directory (an empty manifest whose build id is the Vercel deployment id
   * when it cannot be read); `null` uses an empty manifest.
   */
  manifest?: HypManifest | null;
  log?: Logger;
}

type RouteHandler<Req extends Request, Context> = (
  request: Req,
  context: Context,
) => Response | Promise<Response>;

/**
 * Wraps a Route Handler so its response carries the Vercel CDN headers of the matching edge-cache policy
 * (same planning and verdict as `vercelCdnStage`). The function response is what Vercel's CDN caches, so
 * this is the dependable way to CDN-cache Route Handlers by policy on Vercel:
 *
 * ```ts
 * export const GET = withVercelCdn(config, async (request) => Response.json(await loadProducts()));
 * ```
 */
export function withVercelCdn<Req extends Request = Request, Context = unknown>(
  configInput: ConfigInput,
  handler: RouteHandler<Req, Context>,
  options: WithVercelCdnOptions = {},
): (request: Req, context: Context) => Promise<Response> {
  const config = resolveInput(configInput);
  const cdn = config.vercel.cdn;
  const edge = config.cache.edge;
  if (!cdn || !edge) return async (request, context) => handler(request, context);
  const planner = createPlanner(config, options.downstream ?? cdn.downstream);
  let loading: Promise<HypManifest> | null = null;
  const loadManifest = (): Promise<HypManifest> => {
    if (options.manifest !== undefined) return Promise.resolve(options.manifest ?? emptyManifest());
    loading ??= readBuildManifest().then((found) => {
      if (found) return found;
      const env =
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
      const buildId = env.VERCEL_DEPLOYMENT_ID ?? env.NEXT_DEPLOYMENT_ID;
      return emptyManifest(buildId ? { buildId } : {});
    });
    return loading;
  };
  let matcher: RouteMatcher | null = null;

  return async (request, context) => {
    const manifest = await loadManifest();
    matcher ??= createRouteMatcher(manifest);
    const pathname = new URL(request.url).pathname;
    const ctx = createContext({
      request,
      config,
      manifest,
      route: matcher.match(pathname),
      ...(options.log ? { log: options.log } : {}),
    });
    const { decision, plan } = planner.plan(ctx);
    const response = await handler(request, context);
    if (!plan || decision.status !== 'CDN') return response;
    const verdict = cdnVerdict(plan, response);
    if (!verdict.ok) return response;
    const headers = new Headers(response.headers);
    writeCdnHeaders(headers, verdict.cacheControl, plan);
    if (plan.vary.length) appendListHeader(headers, 'vary', plan.vary);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

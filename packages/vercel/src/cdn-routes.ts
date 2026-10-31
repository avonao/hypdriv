import {
  CDN_CACHE_CONTROL,
  cdnCacheControl,
  routeHeaderSkipReason,
  VERCEL_CACHE_TAG,
  VERCEL_CDN_CACHE_CONTROL,
  type VercelCdnOptions,
} from './cdn';
import { nextHeaderSource } from './route-source';
import { MAX_TAGS_PER_RESPONSE, pathTag, sanitizeTags } from './tags';
import { type ConfigInput, resolveInput } from './util';

export { nextHeaderSource };

/** A `has` / `missing` condition of a `next.config` `headers()` rule (Next's `RouteHas`). */
export type NextRouteCondition =
  | { type: 'header' | 'cookie' | 'query'; key: string; value?: string }
  | { type: 'host'; key?: undefined; value: string };

/** One `next.config` `headers()` rule. */
export interface NextHeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
  has?: NextRouteCondition[];
  missing?: NextRouteCondition[];
}

/** Result of `vercelCdnRouteHeaders`. */
export interface VercelCdnRouteHeaders {
  /** Rules for `headers()`, ordered so that the first matching HypDriv policy wins (later rules override). */
  rules: NextHeaderRule[];
  /** Explicit policies that could not be expressed, with the reason. */
  skipped: Array<{ policy: string; reason: string }>;
}

/**
 * Expresses explicit edge-cache policies as `next.config` `headers()` rules carrying
 * `Vercel-CDN-Cache-Control` (+ `CDN-Cache-Control` when `downstream`) and `Vercel-Cache-Tag`. On Vercel the
 * function response is what the CDN caches and Routing Middleware cannot set caching headers, so this is how
 * page responses get CDN-cached by HypDriv policy; `withHypDriv` merges the rules into `headers()` when
 * deploying to Vercel.
 *
 * Only policies whose meaning survives static route headers are emitted: `respectOrigin: false` (static
 * headers cannot honour a page's own `private`/`no-store`, and with `respectOrigin` the page's own
 * `Cache-Control` already drives Vercel's CDN), no `Vary` needs (the function's own `Vary` replaces route-level
 * ones), and the general `cdnExpressibility` rules. Bypass query parameters and `includeRsc: false` become
 * `missing` conditions. Static headers apply to every status, so `negativeTtl` and `statuses` do not apply.
 * Inferred policies are not emitted: Vercel caches prerendered and ISR output natively.
 */
export function vercelCdnRouteHeaders(
  configInput: ConfigInput,
  options: VercelCdnOptions = {},
): VercelCdnRouteHeaders {
  const config = resolveInput(configInput);
  const cdn = config.vercel.cdn;
  const edge = config.cache.edge;
  if (!cdn || !edge) return { rules: [], skipped: [] };
  const downstream = options.downstream ?? cdn.downstream;
  const rules: NextHeaderRule[] = [];
  const skipped: VercelCdnRouteHeaders['skipped'] = [];

  for (const policy of edge.policies) {
    const reason = routeHeaderSkipReason(policy, config);
    if (reason) {
      skipped.push({ policy: policy.id, reason });
      continue;
    }
    const patterns = Array.isArray(policy.match) ? policy.match : [policy.match];
    const sources = patterns.map((p) => ({ pattern: p, source: nextHeaderSource(p) }));
    const failed = sources.find((s) => s.source === null);
    if (failed) {
      skipped.push({ policy: policy.id, reason: `pattern:${String(failed.pattern)}` });
      continue;
    }
    const cacheControl = cdnCacheControl(policy);
    const missing: NextRouteCondition[] = policy.bypass.query.map((key) => ({ type: 'query', key }));
    if (!policy.includeRsc) missing.push({ type: 'header', key: 'rsc' });
    const policyRules: NextHeaderRule[] = [];
    for (const { source } of sources) {
      const literal = !/[:*()\\]/.test(source!);
      const tags = sanitizeTags(
        [...(literal ? [pathTag(source!)] : []), ...policy.tags],
        MAX_TAGS_PER_RESPONSE,
      );
      const headers = [{ key: VERCEL_CDN_CACHE_CONTROL, value: cacheControl }];
      if (downstream) headers.push({ key: CDN_CACHE_CONTROL, value: cacheControl });
      if (tags.length) headers.push({ key: VERCEL_CACHE_TAG, value: tags.join(',') });
      policyRules.push({ source: source!, headers, ...(missing.length ? { missing } : {}) });
    }
    rules.push(...policyRules);
  }
  // Next.js applies every matching rule and later values win: emit the first policy last.
  return { rules: rules.reverse(), skipped };
}

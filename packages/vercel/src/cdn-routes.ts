import type { PathPattern } from '@hypdriv/core';
import {
  CDN_CACHE_CONTROL,
  cdnCacheControl,
  cdnExpressibility,
  VERCEL_CACHE_TAG,
  VERCEL_CDN_CACHE_CONTROL,
  type VercelCdnOptions,
} from './cdn';
import { MAX_TAGS_PER_RESPONSE, pathTag, sanitizeTags } from './tags';
import { type ConfigInput, resolveInput } from './util';

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

const SPECIAL = new Set(['(', ')', '{', '}', '[', ']', '?', '+', '*', ':', '\\']);

/**
 * Translates a HypDriv route pattern into a Next.js `source` (path-to-regexp): `:name`, `:name*`, `:name?`,
 * `/**` (any depth) and `*` (within a segment) are supported; regular expressions, `^…` patterns and query
 * patterns (`\?`) are not and yield `null`.
 */
export function nextHeaderSource(pattern: PathPattern): string | null {
  if (typeof pattern !== 'string' || !pattern.startsWith('/') || pattern.includes('\\?')) return null;
  let out = '';
  let generated = 0;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
      const after = pattern[i + 3];
      if (after === '/') {
        out += `/:hyp${generated++}*/`;
        i += 4;
        continue;
      }
      if (after === undefined) {
        out += `/:hyp${generated++}*`;
        i += 3;
        continue;
      }
      return null;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += `:hyp${generated++}(.*)`;
        i += 2;
      } else {
        out += `:hyp${generated++}([^/]*)`;
        i += 1;
      }
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(pattern[i + 1] ?? '')) {
      let j = i + 1;
      while (j < pattern.length && /\w/.test(pattern[j]!)) j++;
      const name = pattern.slice(i + 1, j);
      const modifier = pattern[j];
      const segmentStart = out.endsWith('/');
      if (modifier === '*') {
        out += segmentStart ? `:${name}*` : `:${name}(.*)`;
        j++;
      } else if (modifier === '?') {
        out += segmentStart ? `:${name}?` : `:${name}([^/]*)`;
        j++;
      } else {
        out += `:${name}`;
      }
      i = j;
      continue;
    }
    out += SPECIAL.has(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  return out || '/';
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
    if (policy.respectOrigin) {
      skipped.push({ policy: policy.id, reason: 'respect-origin' });
      continue;
    }
    if (policy.ttl < 1) {
      skipped.push({ policy: policy.id, reason: 'zero-ttl' });
      continue;
    }
    if (!policy.methods.includes('GET')) {
      skipped.push({ policy: policy.id, reason: 'methods' });
      continue;
    }
    const expressible = cdnExpressibility(policy, config);
    if (!expressible.ok) {
      skipped.push({ policy: policy.id, reason: expressible.reason });
      continue;
    }
    if (expressible.vary.length) {
      skipped.push({ policy: policy.id, reason: 'vary' });
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

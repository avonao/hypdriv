import { firstMatch, HEADER, type HypManifest, type ResolvedConfig, type ResolvedCsp } from '@hypdriv/core';
import {
  buildCspDirectives,
  buildSecurityHeaders,
  mergeDirectives,
  serializeCsp,
  withoutSource,
} from '@hypdriv/security';

/**
 * Headers for responses the platform serves without running application code (prerendered pages, build assets):
 * HypDriv's security headers, the hash-based CSP of each prerendered document, Early Hints `Link` values and
 * immutable caching for content-hashed assets. Written into the platform's static configuration — Cloudflare's
 * `_headers`, Vercel's Build Output `config.json`, Nitro `routeRules` — so static responses carry the same
 * posture as the ones the runtime pipeline renders.
 */
export interface StaticHeaderRule {
  /** An exact URL path (`/about`) or a prefix pattern ending in `/*` (`/assets/*`, `/*`). */
  path: string;
  /** Headers to set. */
  set: Record<string, string>;
  /** Headers a more general rule set that this path must not carry (route overrides). */
  unset?: string[];
}

export interface StaticDocument {
  /** The manifest route id the document belongs to. */
  routeId: string;
  /** The URL path it is served under (`/`, `/about`, `/blog/hello`). */
  pathname: string;
}

export interface StaticHeadersInput {
  config: ResolvedConfig;
  manifest: HypManifest;
  /** Every prerendered document the platform serves statically. */
  documents: StaticDocument[];
  /** Immutable build asset prefixes (`/assets/`, `/_astro/`, `/_app/immutable/`); default the manifest's. */
  immutablePrefixes?: string[];
  /** Also emit each document's alternate spelling with a trailing slash (`/about/` for `/about`). Default true. */
  trailingSlashVariants?: boolean;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** The hash-mode policy (and report-only companion) of a prerendered document. */
export function staticCspHeaders(
  config: ResolvedConfig,
  manifest: HypManifest,
  doc: StaticDocument,
): Record<string, string> {
  const csp = config.security.csp;
  if (!csp) return {};
  const url = new URL(doc.pathname, 'https://hypdriv.invalid');
  const override = firstMatch(csp.routes, url);
  const configured = override?.mode ?? csp.mode;
  if (configured === 'off') return { [HEADER.cspMode]: 'off' };
  const reportOnly = override?.reportOnly ?? csp.reportOnly;
  const effective: ResolvedCsp = override
    ? { ...csp, directives: mergeDirectives(csp.directives, override.directives) }
    : csp;
  const hashes = manifest.csp[`${doc.routeId}#${doc.pathname}`] ??
    manifest.csp[doc.routeId] ?? {
      scriptHashes: [],
      styleHashes: [],
    };
  const extra = [
    ...(manifest.inlineScriptHashes ?? []),
    ...(manifest.purser?.themeScriptHash ? [manifest.purser.themeScriptHash] : []),
  ];
  // A static file cannot carry a per-request nonce: hash mode is the only enforceable policy.
  const directives = buildCspDirectives({
    config: effective,
    mode: 'hash',
    hashes,
    extraScriptHashes: [...new Set(extra)],
    development: false,
  });
  const policy = serializeCsp(directives);
  const out: Record<string, string> = {};
  if (reportOnly === true) {
    out['content-security-policy-report-only'] = policy;
    out[HEADER.cspMode] = 'report-only';
  } else {
    out['content-security-policy'] = policy;
    if (reportOnly === 'both')
      out['content-security-policy-report-only'] = serializeCsp(withoutSource(directives, "'unsafe-inline'"));
    out[HEADER.cspMode] = 'hash';
  }
  if (effective.reportTo && effective.reportingEndpoints)
    out['reporting-endpoints'] = `hypdriv="${absolute(effective.reportTo, config.site.origin)}"`;
  return out;
}

function absolute(path: string, origin: string | null | undefined): string {
  if (!origin) return path;
  try {
    return new URL(path, origin).href;
  } catch {
    return path;
  }
}

/**
 * Computes the static header rules: a base rule for every path (`/*`: the security header preset), immutable
 * caching for content-hashed assets, and one rule per prerendered document (CSP, Early Hints, route overrides
 * of the security headers).
 */
export function staticHeaderRules(input: StaticHeadersInput): StaticHeaderRule[] {
  const { config, manifest } = input;
  const rules: StaticHeaderRule[] = [];
  const headersConfig = config.security.headers;
  // Route overrides change the preset for some paths; the base rule carries the default preset only.
  const defaultBase = headersConfig
    ? lower(
        buildSecurityHeaders(
          { ...headersConfig, routes: [] },
          { development: false, https: true, pathname: '/__hypdriv_default__' },
        ),
      )
    : {};
  if (Object.keys(defaultBase).length) rules.push({ path: '/*', set: defaultBase });

  const prefixes = input.immutablePrefixes ?? manifest.staticFiles.immutablePrefixes;
  for (const prefix of [...new Set(prefixes)]) {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    rules.push({ path: `${normalized}*`, set: { 'cache-control': IMMUTABLE } });
  }

  const seen = new Set<string>();
  const variants = input.trailingSlashVariants ?? true;
  for (const doc of input.documents) {
    const set: Record<string, string> = {};
    const unset: string[] = [];
    if (headersConfig) {
      const own = lower(
        buildSecurityHeaders(headersConfig, { development: false, https: true, pathname: doc.pathname }),
      );
      for (const [k, v] of Object.entries(own)) if (defaultBase[k] !== v) set[k] = v;
      for (const k of Object.keys(defaultBase)) if (!(k in own)) unset.push(k);
    }
    Object.assign(set, staticCspHeaders(config, manifest, doc));
    const hints = config.performance.earlyHints ? manifest.earlyHints[doc.routeId] : undefined;
    if (hints?.length) set.link = hints.join(', ');
    const paths = [doc.pathname];
    if (variants && doc.pathname !== '/') {
      paths.push(doc.pathname.endsWith('/') ? doc.pathname.slice(0, -1) : `${doc.pathname}/`);
    }
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!Object.keys(set).length && !unset.length) continue;
      rules.push({ path, set: { ...set }, ...(unset.length ? { unset: [...unset] } : {}) });
    }
  }
  return rules;
}

/** Cloudflare Workers static assets / Pages limits for `_headers`. */
export const CLOUDFLARE_HEADERS_LIMITS = { rules: 100, lineLength: 2000 } as const;

const CF_START = '# hypdriv:start — generated by HypDriv; edits inside this block are overwritten';
const CF_END = '# hypdriv:end';

/**
 * Renders rules in Cloudflare's `_headers` syntax and merges them into an existing file's content: HypDriv's
 * block replaces a previous one, the rest of the file (framework or user rules) is kept after it. When the
 * rules exceed Cloudflare's limits, per-document rules are dropped (most specific first is kept up to the
 * limit) and reported in `dropped`; the runtime still sends their CSP when the Worker serves them.
 */
export function renderCloudflareHeaders(
  rules: StaticHeaderRule[],
  existing = '',
): { content: string; dropped: string[] } {
  const kept: StaticHeaderRule[] = [];
  const dropped: string[] = [];
  const existingRules = existing
    .split('\n')
    .filter((line) => line.length && !/^\s/.test(line) && !line.startsWith('#')).length;
  const budget = Math.max(0, CLOUDFLARE_HEADERS_LIMITS.rules - existingRules);
  for (const rule of rules) {
    const tooLong = Object.entries(rule.set).some(
      ([k, v]) => `  ${k}: ${v}`.length > CLOUDFLARE_HEADERS_LIMITS.lineLength,
    );
    if (tooLong || kept.length >= budget) {
      dropped.push(rule.path);
      continue;
    }
    kept.push(rule);
  }
  const block = [CF_START];
  for (const rule of kept) {
    block.push(rule.path);
    for (const name of rule.unset ?? []) block.push(`  ! ${name}`);
    for (const [k, v] of Object.entries(rule.set)) block.push(`  ${k}: ${v}`);
  }
  block.push(CF_END);
  const rest = stripBlock(existing, CF_START, CF_END).trim();
  return { content: `${block.join('\n')}\n${rest ? `\n${rest}\n` : ''}`, dropped };
}

function stripBlock(text: string, start: string, end: string): string {
  const a = text.indexOf(start.split(' —')[0]!);
  if (a < 0) return text;
  const b = text.indexOf(end, a);
  if (b < 0) return text.slice(0, a);
  return text.slice(0, a) + text.slice(b + end.length);
}

/** A Vercel Build Output API v3 route. */
export interface VercelRoute {
  src?: string;
  dest?: string;
  headers?: Record<string, string>;
  continue?: boolean;
  handle?: string;
  status?: number;
  [key: string]: unknown;
}

/** Converts a rule path into a Build Output API `src` regex. */
export function vercelSource(path: string): string {
  if (path === '/*') return '^/(?:.*)$';
  if (path.endsWith('/*')) {
    const prefix = path.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `^${prefix}/(?:.*)$`;
  }
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}$`;
}

/** Marker header on HypDriv's Build Output routes so a re-run replaces them. */
export const VERCEL_ROUTE_MARKER = 'x-hypdriv-static';

/**
 * Inserts the rules into Build Output API routes before `{ handle: 'filesystem' }` (so they apply to static files
 * and function responses alike), replacing HypDriv routes from a previous run. Header removals are expressed as
 * empty values, which Vercel drops.
 */
export function mergeVercelRoutes(routes: VercelRoute[], rules: StaticHeaderRule[]): VercelRoute[] {
  const own = (r: VercelRoute) => r.headers?.[VERCEL_ROUTE_MARKER] !== undefined;
  const rest = routes.filter((r) => !own(r));
  const generated: VercelRoute[] = rules.map((rule) => ({
    src: vercelSource(rule.path),
    headers: {
      ...Object.fromEntries((rule.unset ?? []).map((name) => [name, ''])),
      ...rule.set,
      [VERCEL_ROUTE_MARKER]: '1',
    },
    continue: true,
  }));
  const fs = rest.findIndex((r) => r.handle === 'filesystem');
  // Leading routes that are not header-only (redirects, trailing-slash normalisation) keep running first.
  const insertAt = Math.max(fs, 0);
  return [...rest.slice(0, insertAt), ...generated, ...rest.slice(insertAt)];
}

import {
  defineStage,
  type HypContext,
  matchesAny,
  parseDuration,
  type ResolvedConfig,
  type ResolvedSecurityHeaders,
  rebuildResponse,
  type SecurityHeadersConfig,
  type Stage,
} from '@hypdriv/core';

/** Options of `buildSecurityHeaders`. */
export interface SecurityHeadersOptions {
  development: boolean;
  /** `true` when the response is served over HTTPS; HSTS is only emitted then. */
  https: boolean;
  pathname: string;
}

/** Serialises a Permissions-Policy map: `camera=(), fullscreen=(self "https://x.example")`. */
export function serializePermissionsPolicy(policy: Record<string, string[]>): string {
  return Object.keys(policy)
    .sort()
    .map((feature) => {
      const allow = policy[feature] ?? [];
      if (allow.includes('*')) return `${feature}=*`;
      const tokens = allow.map((entry) => {
        const v = entry.trim();
        if (v === 'self' || v === "'self'") return 'self';
        if (v === 'src' || v === "'src'") return 'src';
        if (v === 'none' || v === "'none'") return '';
        return v.startsWith('"') ? v : `"${v}"`;
      });
      return `${feature}=(${tokens.filter(Boolean).join(' ')})`;
    })
    .join(', ');
}

type RouteOverride = Partial<Omit<SecurityHeadersConfig, 'routes'>>;

/** Applies a per-route override (raw config shape) over the resolved header config. */
export function applyHeaderOverride(
  base: ResolvedSecurityHeaders,
  o: RouteOverride,
): ResolvedSecurityHeaders {
  const out: ResolvedSecurityHeaders = { ...base, extra: { ...base.extra } };
  if (o.hsts !== undefined)
    out.hsts =
      o.hsts === false
        ? null
        : {
            maxAge: parseDuration(o.hsts.maxAge, base.hsts?.maxAge ?? 63072000),
            includeSubDomains: o.hsts.includeSubDomains ?? base.hsts?.includeSubDomains ?? true,
            preload: o.hsts.preload ?? base.hsts?.preload ?? false,
          };
  if (o.coop !== undefined) out.coop = o.coop === false ? null : o.coop;
  if (o.corp !== undefined) out.corp = o.corp === false ? null : o.corp;
  if (o.coep !== undefined) out.coep = o.coep === false ? null : o.coep;
  if (o.referrerPolicy !== undefined)
    out.referrerPolicy = o.referrerPolicy === false ? null : o.referrerPolicy;
  if (o.permissionsPolicy !== undefined)
    out.permissionsPolicy =
      o.permissionsPolicy === false
        ? null
        : Object.fromEntries(
            Object.entries({ ...(base.permissionsPolicy ?? {}), ...o.permissionsPolicy }).map(([k, v]) => [
              k,
              [...v],
            ]),
          );
  if (o.frameOptions !== undefined) out.frameOptions = o.frameOptions === false ? null : o.frameOptions;
  if (o.noSniff !== undefined) out.noSniff = o.noSniff;
  if (o.dnsPrefetchControl !== undefined)
    out.dnsPrefetchControl = o.dnsPrefetchControl === false ? null : o.dnsPrefetchControl;
  if (o.permittedCrossDomainPolicies !== undefined)
    out.permittedCrossDomainPolicies =
      o.permittedCrossDomainPolicies === false ? null : o.permittedCrossDomainPolicies;
  if (o.originAgentCluster !== undefined) out.originAgentCluster = o.originAgentCluster;
  if (o.stripFingerprints !== undefined) out.stripFingerprints = o.stripFingerprints;
  if (o.extra) Object.assign(out.extra, o.extra);
  return out;
}

/** Resolves the effective header config for a pathname (first matching route override wins). */
export function effectiveHeaderConfig(
  config: ResolvedSecurityHeaders,
  pathname: string,
): ResolvedSecurityHeaders {
  for (const route of config.routes) {
    if (matchesAny(route.match, pathname)) return applyHeaderOverride(config, route.headers);
  }
  return config;
}

/**
 * Builds the response header map (canonical header casing). HSTS is emitted only over HTTPS and never in
 * development, so a local `http://` session cannot pin the browser.
 */
export function buildSecurityHeaders(
  config: ResolvedSecurityHeaders,
  options: SecurityHeadersOptions,
): Record<string, string> {
  const c = effectiveHeaderConfig(config, options.pathname);
  const headers: Record<string, string> = {};
  if (c.hsts && options.https && !options.development) {
    let v = `max-age=${c.hsts.maxAge}`;
    if (c.hsts.includeSubDomains) v += '; includeSubDomains';
    if (c.hsts.preload) v += '; preload';
    headers['Strict-Transport-Security'] = v;
  }
  if (c.coop) headers['Cross-Origin-Opener-Policy'] = c.coop;
  if (c.corp) headers['Cross-Origin-Resource-Policy'] = c.corp;
  if (c.coep) headers['Cross-Origin-Embedder-Policy'] = c.coep;
  if (c.referrerPolicy) headers['Referrer-Policy'] = c.referrerPolicy;
  if (c.permissionsPolicy && Object.keys(c.permissionsPolicy).length)
    headers['Permissions-Policy'] = serializePermissionsPolicy(c.permissionsPolicy);
  if (c.frameOptions) headers['X-Frame-Options'] = c.frameOptions;
  if (c.noSniff) headers['X-Content-Type-Options'] = 'nosniff';
  if (c.dnsPrefetchControl) headers['X-DNS-Prefetch-Control'] = c.dnsPrefetchControl;
  if (c.permittedCrossDomainPolicies)
    headers['X-Permitted-Cross-Domain-Policies'] = c.permittedCrossDomainPolicies;
  if (c.originAgentCluster) headers['Origin-Agent-Cluster'] = '?1';
  for (const [k, v] of Object.entries(c.extra)) headers[k] = v;
  return headers;
}

/** Headers removed when `stripFingerprints` is on (`x-opennext` is kept on purpose). */
export const FINGERPRINT_HEADERS = ['x-powered-by', 'server'] as const;

/** Applies the preset to a response without clobbering headers the application set. */
export function applySecurityHeaders(
  response: Response,
  built: Record<string, string>,
  options: { stripFingerprints: boolean },
): Response {
  const headers = new Headers(response.headers);
  let changed = false;
  if (options.stripFingerprints) {
    for (const name of FINGERPRINT_HEADERS) {
      if (headers.has(name)) {
        headers.delete(name);
        changed = true;
      }
    }
  }
  for (const [name, value] of Object.entries(built)) {
    if (headers.has(name)) continue;
    headers.set(name, value);
    changed = true;
  }
  if (!changed) return response;
  return rebuildResponse(response, headers);
}

/**
 * The `security-headers` stage. Runs on internal paths too so `/_next/static` assets get `nosniff` and
 * `Cross-Origin-Resource-Policy`. Built header maps are memoised per route override / scheme / mode.
 */
export function securityHeadersStage(config: ResolvedConfig): Stage {
  const hc = config.security.headers;
  const memo = new Map<string, { built: Record<string, string>; stripFingerprints: boolean }>();
  const overrideIndex = (ctx: HypContext): number => {
    if (!hc) return -1;
    for (let i = 0; i < hc.routes.length; i++) if (matchesAny(hc.routes[i]!.match, ctx.url)) return i;
    return -1;
  };
  return defineStage({
    name: 'security-headers',
    runOnInternal: true,
    post(ctx, response) {
      if (!hc) return response;
      const https = ctx.url.protocol === 'https:';
      const key = `${overrideIndex(ctx)}|${https ? 1 : 0}|${ctx.development ? 1 : 0}`;
      let entry = memo.get(key);
      if (!entry) {
        const effective = effectiveHeaderConfig(hc, ctx.url.pathname);
        entry = {
          built: buildSecurityHeaders(effective, {
            development: ctx.development,
            https,
            pathname: ctx.url.pathname,
          }),
          stripFingerprints: effective.stripFingerprints,
        };
        memo.set(key, entry);
      }
      return applySecurityHeaders(response, entry.built, { stripFingerprints: entry.stripFingerprints });
    },
  });
}

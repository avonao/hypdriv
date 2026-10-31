import {
  cleanRoutePathname,
  type HypContext,
  type HypManifest,
  type HypRoute,
  matchesAny,
  type PathPattern,
  patternSpecificity,
  type ResolvedConfig,
  type ResolvedEdgeCachePolicy,
  type RouteMatch,
  type RoutePattern,
  resolveEdgeCachePolicy,
  stripBasePath,
} from '@hypdriv/core';

/** Prefix of inferred policy ids (`inferred:app:/blog/[slug]`). */
export const INFERRED_POLICY_PREFIX = 'inferred:';

/**
 * Converts a Next.js route pathname into a core route pattern: `[param]` → `:param`,
 * `[...rest]` → `:rest*`; route groups and parallel slots are removed. An optional catch-all
 * (`[[...rest]]`) yields two patterns because `/shop/:rest*` alone does not match `/shop`.
 */
export function nextPathnameToPattern(pathname: string): string | string[] {
  const cleaned = cleanRoutePathname(pathname);
  const segments = cleaned.split('/').filter(Boolean);
  const parts: string[] = [];
  let optionalCatchAll = false;
  for (const seg of segments) {
    let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
    if (m) {
      optionalCatchAll = true;
      parts.push(`:${safeParam(m[1]!)}*`);
      continue;
    }
    m = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
    if (m) {
      parts.push(`:${safeParam(m[1]!)}*`);
      continue;
    }
    m = /^\[([^\]]+)\]$/.exec(seg);
    if (m) {
      parts.push(`:${safeParam(m[1]!)}`);
      continue;
    }
    parts.push(seg);
  }
  const full = `/${parts.join('/')}`;
  if (!optionalCatchAll) return full || '/';
  const base = `/${parts.slice(0, -1).join('/')}`.replace(/\/$/, '') || '/';
  return [base, full];
}

function safeParam(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Specificity of a route pattern (the broadest member decides for lists), for ordering inferred policies. */
export function routePatternSpecificity(pattern: RoutePattern): number {
  const list: PathPattern[] = Array.isArray(pattern) ? pattern : [pattern];
  return Math.min(...list.map((p) => patternSpecificity(p)));
}

/**
 * Derives policies from the manifest: `static` and `isr` routes get `inferredStatic` durations
 * (ISR routes cap the TTL at the route's `revalidate`), `shell` routes only when `inferredShell` is set.
 * Ordered by pattern specificity, most specific first.
 */
export function inferPolicies(config: ResolvedConfig, manifest: HypManifest): ResolvedEdgeCachePolicy[] {
  const edge = config.cache.edge;
  if (!edge?.infer) return [];
  const out: Array<{ policy: ResolvedEdgeCachePolicy; specificity: number; index: number }> = [];
  manifest.routes.forEach((route, index) => {
    const durations = inferredDurations(route, edge);
    if (!durations) return;
    const match = nextPathnameToPattern(route.pathname);
    const policy = resolveEdgeCachePolicy(
      {
        id: `${INFERRED_POLICY_PREFIX}${route.id}`,
        match,
        ttl: durations.ttl,
        swr: durations.swr,
        staleIfError: durations.staleIfError,
        tags: [`route:${route.id}`],
      },
      index,
      'inferred',
      edge.bypass,
    );
    out.push({ policy, specificity: routePatternSpecificity(match), index });
  });
  out.sort((a, b) => b.specificity - a.specificity || a.index - b.index);
  return out.map((o) => o.policy);
}

function inferredDurations(
  route: HypRoute,
  edge: NonNullable<ResolvedConfig['cache']['edge']>,
): { ttl: number; swr: number; staleIfError: number } | null {
  // A fallback document served for every unmatched path (a single-page app's shell) is not per-URL content: an
  // inferred policy would also capture whatever else answers under the pattern (the Worker's own API routes).
  if (route.fallback) return null;
  // A prerendered document the platform's static layer serves (Workers Static Assets, the Vercel CDN,
  // `hypdriv serve`) is already cached there; a second copy in the edge cache only adds staleness.
  if (route.servedStatically) return null;
  switch (route.classification) {
    case 'static':
      return { ...edge.inferredStatic };
    case 'isr': {
      const revalidate = route.prerender?.revalidate;
      const ttl =
        typeof revalidate === 'number' && Number.isFinite(revalidate) && revalidate >= 0
          ? Math.min(edge.inferredStatic.ttl, revalidate)
          : edge.inferredStatic.ttl;
      return { ttl, swr: edge.inferredStatic.swr, staleIfError: edge.inferredStatic.staleIfError };
    }
    case 'shell':
      return edge.inferredShell ? { ...edge.inferredShell, staleIfError: 0 } : null;
    default:
      return null;
  }
}

/** Explicit policies (config order) followed by inferred ones (specificity order). */
export function resolvePolicies(config: ResolvedConfig, manifest: HypManifest): ResolvedEdgeCachePolicy[] {
  const edge = config.cache.edge;
  if (!edge) return [];
  return [...edge.policies, ...inferPolicies(config, manifest)];
}

interface PolicyIndex {
  explicit: ResolvedEdgeCachePolicy[];
  inferred: ResolvedEdgeCachePolicy[];
  byId: Map<string, ResolvedEdgeCachePolicy>;
  inferredByRoute: Map<string, ResolvedEdgeCachePolicy>;
}

const indexes = new WeakMap<ResolvedEdgeCachePolicy[], PolicyIndex>();

function indexPolicies(policies: ResolvedEdgeCachePolicy[]): PolicyIndex {
  let idx = indexes.get(policies);
  if (idx) return idx;
  idx = { explicit: [], inferred: [], byId: new Map(), inferredByRoute: new Map() };
  for (const p of policies) {
    if (!idx.byId.has(p.id)) idx.byId.set(p.id, p);
    if (p.source === 'inferred') {
      idx.inferred.push(p);
      if (p.id.startsWith(INFERRED_POLICY_PREFIX))
        idx.inferredByRoute.set(p.id.slice(INFERRED_POLICY_PREFIX.length), p);
    } else idx.explicit.push(p);
  }
  indexes.set(policies, idx);
  return idx;
}

/**
 * Policy lookup without a context: the route's precomputed `cachePolicyId`, then explicit policies
 * by pattern (config order), then the inferred policy of the matched route, then inferred patterns.
 */
export function matchPolicyFor(
  policies: ResolvedEdgeCachePolicy[],
  url: URL,
  route: RouteMatch | null,
  basePath?: string | null,
): ResolvedEdgeCachePolicy | null {
  const idx = indexPolicies(policies);
  const target = basePath ? stripBasePath(url.pathname, basePath) + url.search : url;
  if (route?.route.cachePolicyId) {
    const hit = idx.byId.get(route.route.cachePolicyId);
    if (hit) return hit;
  }
  for (const p of idx.explicit) if (matchesAny(p.match, target)) return p;
  if (route) {
    const hit = idx.inferredByRoute.get(route.route.id);
    if (hit) return hit;
  }
  for (const p of idx.inferred) if (matchesAny(p.match, target)) return p;
  return null;
}

/** Finds the policy for a request; explicit policies win over inferred ones. */
export function matchPolicy(
  policies: ResolvedEdgeCachePolicy[],
  ctx: HypContext,
): ResolvedEdgeCachePolicy | null {
  return matchPolicyFor(policies, ctx.url, ctx.route, ctx.manifest.basePath);
}

/** Downstream `Cache-Control` for responses whose origin set none: browsers revalidate, CDNs use the policy. */
export function cacheControlFor(
  policy: Pick<ResolvedEdgeCachePolicy, 'ttl' | 'swr' | 'staleIfError'>,
): string {
  const parts = ['public', 'max-age=0', `s-maxage=${Math.max(0, Math.floor(policy.ttl))}`];
  if (policy.swr > 0) parts.push(`stale-while-revalidate=${Math.floor(policy.swr)}`);
  if (policy.staleIfError > 0) parts.push(`stale-if-error=${Math.floor(policy.staleIfError)}`);
  return parts.join(', ');
}

/** Longest pathname that still gets a `path:` tag (Cloudflare caps a single cache tag at 1,024 bytes). */
export const MAX_PATH_TAG_LENGTH = 512;

/**
 * The per-path tag of an entry (`path:/blog/hello`): one tag for every variant of a page, so
 * `revalidatePath()` and ISR revalidation drop them all. Trailing slashes are ignored; `null` for paths
 * longer than {@link MAX_PATH_TAG_LENGTH}.
 */
export function pathTag(pathname: string): string | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname || '/';
  return normalized.length > MAX_PATH_TAG_LENGTH ? null : `path:${normalized}`;
}

/**
 * Tags attached to an entry: policy tags, `route:<id>` when a route matched, `path:<pathname>` when the
 * pathname is given, and `build:<buildId>`.
 */
export function effectiveTags(
  policy: ResolvedEdgeCachePolicy,
  route: RouteMatch | null,
  buildId: string,
  pathname?: string,
): string[] {
  const tags = new Set<string>(policy.tags);
  if (route) tags.add(`route:${route.route.id}`);
  const path = pathname === undefined ? null : pathTag(pathname);
  if (path) tags.add(path);
  tags.add(`build:${buildId}`);
  return [...tags];
}

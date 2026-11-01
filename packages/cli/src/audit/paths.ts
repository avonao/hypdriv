import type { HypManifest, HypRoute } from '@hypdriv/core';

export interface AuditPath {
  path: string;
  route: HypRoute | null;
}

const HIDDEN = new Set(['/_not-found', '/_global-error', '/_error', '/404', '/500']);

/** `true` for routes that render HTML documents (pages). */
export function isPageRoute(route: HypRoute): boolean {
  return route.kind === 'app-page' || route.kind === 'page';
}

/** Concrete request paths for a route: its pathname when static, prerendered paths when dynamic. */
export function concretePaths(route: HypRoute, basePath = ''): string[] {
  if (!route.dynamic) return [basePath + route.pathname];
  return (route.prerender?.paths ?? []).map((p) => (p.startsWith(basePath) ? p : basePath + p));
}

/**
 * Chooses the paths an audit should hit: static and ISR pages first, then one concrete path per
 * dynamic route, then `/`, de-duplicated and capped at `limit`. Explicit `--paths` win.
 */
export function choosePaths(
  manifest: HypManifest | null,
  options: { paths?: string[]; limit?: number; includeRoutes?: boolean } = {},
): AuditPath[] {
  const limit = options.limit ?? 20;
  const out: AuditPath[] = [];
  const seen = new Set<string>();
  const explicit = Boolean(options.paths?.length);
  // Next with `trailingSlash: true` answers the slashless form with a redirect: audit the pages, not the redirects.
  const slashed = !explicit && manifest?.trailingSlash === true;
  const push = (path: string, route: HypRoute | null) => {
    let normalized = path.startsWith('/') ? path : `/${path}`;
    if (
      slashed &&
      normalized.length > 1 &&
      !normalized.endsWith('/') &&
      !/\.[A-Za-z0-9]{1,8}$/.test(normalized)
    )
      normalized = `${normalized}/`;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ path: normalized, route });
  };
  if (options.paths?.length) {
    for (const p of options.paths) push(p, manifest ? findRoute(manifest, p) : null);
    return out;
  }
  if (!manifest) {
    push('/', null);
    return out;
  }
  const pages = manifest.routes.filter(
    (r) =>
      (isPageRoute(r) || (options.includeRoutes && (r.kind === 'app-route' || r.kind === 'endpoint'))) &&
      !HIDDEN.has(r.pathname),
  );
  const cached = pages.filter((r) => r.classification === 'static' || r.classification === 'isr');
  const rest = pages.filter((r) => !cached.includes(r));
  for (const route of cached)
    for (const p of concretePaths(route, manifest.basePath).slice(0, route.dynamic ? 2 : 1)) push(p, route);
  for (const route of rest) {
    const first = concretePaths(route, manifest.basePath)[0];
    if (first) push(first, route);
  }
  push(`${manifest.basePath}/` === '//' ? '/' : `${manifest.basePath || ''}/`, findRoute(manifest, '/'));
  return out.slice(0, limit);
}

/** Finds the route for a concrete path (exact pathname or regex match). */
export function findRoute(manifest: HypManifest, path: string): HypRoute | null {
  const pathname = path.split('?')[0]!.split('#')[0]!;
  const stripped =
    manifest.basePath && pathname.startsWith(manifest.basePath)
      ? pathname.slice(manifest.basePath.length) || '/'
      : pathname;
  const exact = manifest.routes.find(
    (r) => !r.dynamic && r.pathname === stripped && r.kind !== 'static-file',
  );
  if (exact) return exact;
  for (const r of manifest.routes) {
    if (!r.dynamic || !r.regex) continue;
    try {
      if (new RegExp(r.regex).test(stripped)) return r;
    } catch {
      // ignore invalid regex
    }
  }
  return null;
}

/** Expected CSP mode for a route per ADR 0006. */
export function cspModeFor(route: HypRoute | null, manifest: HypManifest | null): 'hash' | 'nonce' | 'none' {
  if (!route) return 'nonce';
  if (
    route.kind === 'app-route' ||
    route.kind === 'page-api' ||
    route.kind === 'endpoint' ||
    route.kind === 'static-file'
  )
    return 'none';
  if (route.classification === 'static' && manifest?.csp?.[route.id]) return 'hash';
  return 'nonce';
}

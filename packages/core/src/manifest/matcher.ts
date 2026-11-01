import { normalizeTrailingSlash, stripBasePath } from '../http/url';
import type { HypManifest, HypRoute, RouteMatch } from './types';

export interface RouteMatcher {
  match(pathname: string): RouteMatch | null;
  byId(id: string): HypRoute | undefined;
  readonly size: number;
}

/**
 * Converts a route pattern in Hypdriv's canonical (Next.js) syntax — `/blog/[slug]`, `/docs/[...path]`,
 * `/shop/[[...slug]]`, `/[[lang]]/about` (optional segment), `/(group)/about`, `/@slot/page` — into a regular
 * expression with named groups. Other frameworks' patterns are converted to this syntax at build time.
 */
/** Removes route groups `(name)` and parallel slots `@name` from a Next.js route pattern. */
export function cleanRoutePathname(pathname: string): string {
  const cleaned = pathname
    .split('/')
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')) && !seg.startsWith('@'))
    .join('/');
  return cleaned || '/';
}

export function routePatternToRegex(pathname: string): string {
  const cleaned = cleanRoutePathname(pathname);
  // A regular expression cannot repeat a group name: `/a/[x]/b/[x]` or `[a-b]` + `[a_b]` (both `a_b`) get `_2`, `_3`…
  const used = new Set<string>();
  const groupName = (raw: string): string => {
    const base = safeName(raw);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
  };
  const source = cleaned
    .split('/')
    .map((seg) => {
      let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
      if (m) return `(?:/(?<${groupName(m[1]!)}>.+?))?`;
      m = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
      if (m) return `/(?<${groupName(m[1]!)}>.+?)`;
      // Optional single segment (SvelteKit `[[lang]]`, React Router `:lang?`).
      m = /^\[\[([^\].]+)\]\]$/.exec(seg);
      if (m) return `(?:/(?<${groupName(m[1]!)}>[^/]+?))?`;
      m = /^\[([^\]]+)\]$/.exec(seg);
      if (m) return `/(?<${groupName(m[1]!)}>[^/]+?)`;
      return seg === '' ? '' : `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return `^${source || '/'}(?:/)?$`;
}

function safeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_');
  // A group name must not start with a digit.
  return /^[0-9]/.test(safe) ? `_${safe}` : safe || '_';
}

/** Options of `createRouteMatcher`. */
export interface RouteMatcherOptions {
  /**
   * Called for a route whose expression cannot be compiled (its own `regex` and the one derived from its pattern
   * both throw). The route is left out of the matcher instead of failing every request; the callback is the place
   * to log it.
   */
  onInvalidRoute?: (route: HypRoute, error: Error) => void;
}

/** Builds the route matcher: exact map for static paths, ordered regex list for dynamic ones. */
export function createRouteMatcher(
  manifest: Pick<HypManifest, 'routes' | 'basePath' | 'trailingSlash'>,
  options: RouteMatcherOptions = {},
): RouteMatcher {
  const exact = new Map<string, HypRoute>();
  const dynamic: Array<{ route: HypRoute; regex: RegExp }> = [];
  const byId = new Map<string, HypRoute>();

  for (const route of manifest.routes) {
    byId.set(route.id, route);
    if (route.kind === 'static-file') {
      exact.set(route.pathname, route);
      continue;
    }
    if (!route.dynamic) {
      exact.set(normalizeTrailingSlash(cleanRoutePathname(route.pathname), null), route);
      continue;
    }
    try {
      dynamic.push({ route, regex: new RegExp(route.regex || routePatternToRegex(route.pathname)) });
    } catch {
      try {
        dynamic.push({ route, regex: new RegExp(routePatternToRegex(route.pathname)) });
      } catch (error) {
        // One route nobody can compile must not take every other route down with it.
        options.onInvalidRoute?.(route, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  // More specific first: fewer dynamic segments, longer literal prefix.
  dynamic.sort((a, b) => specificity(b.route.pathname) - specificity(a.route.pathname));

  return {
    size: manifest.routes.length,
    byId: (id) => byId.get(id),
    match(pathname) {
      const stripped = stripBasePath(pathname, manifest.basePath);
      const normalized = normalizeTrailingSlash(stripped, null);
      const hit = exact.get(normalized) ?? exact.get(stripped);
      if (hit) return { route: hit, params: {} };
      for (const { route, regex } of dynamic) {
        const m = regex.exec(normalized);
        if (m) {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(m.groups ?? {})) {
            if (v === undefined) continue;
            try {
              params[k] = decodeURIComponent(v);
            } catch {
              params[k] = v;
            }
          }
          return { route, params };
        }
      }
      return null;
    },
  };
}

function specificity(pathname: string): number {
  const segments = pathname.split('/').filter(Boolean);
  let score = 0;
  for (const seg of segments) {
    if (seg.startsWith('[[...')) score += 1;
    else if (seg.startsWith('[...')) score += 2;
    else if (seg.startsWith('[[')) score += 3;
    else if (seg.startsWith('[')) score += 5;
    else score += 10;
  }
  return score * 100 + segments.length;
}

/** Stable route id used across the manifest, cache tags and Server-Timing. */
export function routeId(kind: HypRoute['kind'], pathname: string): string {
  const prefix =
    kind === 'app-page'
      ? 'app'
      : kind === 'app-route'
        ? 'route'
        : kind === 'page'
          ? 'page'
          : kind === 'page-api'
            ? 'api'
            : kind === 'endpoint'
              ? 'endpoint'
              : 'static';
  return `${prefix}:${pathname}`;
}

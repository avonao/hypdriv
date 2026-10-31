import type { RouteAssetSources } from '@hypdriv/build';
import {
  cleanRoutePathname,
  type HypRoute,
  type HypRoutePrerender,
  type RouteClassification,
  routeId,
  routePatternToRegex,
} from '@hypdriv/core';

/**
 * A route as a framework integration discovers it. `pathname` uses HypDriv's canonical pattern syntax
 * (`/blog/[slug]`, `/docs/[...path]`, `/[[lang]]/about`); the converters below translate framework syntaxes.
 */
export interface DiscoveredRoute {
  pathname: string;
  /** `page` renders HTML; `endpoint` is a server route (API, resource route, `+server`, Nitro handler). */
  kind: 'page' | 'endpoint';
  /**
   * Whether the route is prerendered at build time. Integrations that only learn it from the build output can
   * leave it unset: a document found for the route marks it prerendered.
   */
  prerendered?: boolean;
  /** Seconds between background regenerations (ISR), when the framework/platform regenerates the page. */
  revalidate?: number | false;
  /** The framework's own matcher for the route, when more exact than the converted pattern. */
  regex?: string;
  /** Source file relative to the project (`src/routes/blog/[slug]/+page.svelte`). */
  sourcePage?: string;
  /** Client assets the framework's build reports for the route. */
  sources?: RouteAssetSources;
  /** A framework-specific id kept for diagnostics. */
  frameworkId?: string;
  /** The route is a fallback document served for every unmatched path (a single-page app's shell). */
  fallback?: boolean;
}

/** Whether a canonical pattern has dynamic segments. */
export function isDynamicPattern(pathname: string): boolean {
  return /\[[^\]]+\]/.test(pathname);
}

/** Normalises a pathname: leading slash, no trailing slash (except `/`), no duplicate slashes. */
export function normalizePathname(pathname: string): string {
  let p = `/${pathname}`.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

/** Builds the manifest route for a discovered route. */
export function toHypRoute(route: DiscoveredRoute, prerenderedPaths: string[] = []): HypRoute {
  const pathname = normalizePathname(route.pathname);
  const dynamic = isDynamicPattern(cleanRoutePathname(pathname));
  const prerendered = route.prerendered === true || prerenderedPaths.length > 0;
  let classification: RouteClassification;
  if (route.kind === 'endpoint') classification = prerendered && !dynamic ? 'static' : 'route';
  else if (prerendered && !(dynamic && route.prerendered !== true && prerenderedPaths.length === 0))
    classification = typeof route.revalidate === 'number' && route.revalidate > 0 ? 'isr' : 'static';
  else classification = 'dynamic';
  // A dynamic page with some prerendered paths still renders the others per request.
  if (route.kind === 'page' && dynamic && route.prerendered !== true) classification = 'dynamic';
  const kind = route.kind === 'endpoint' ? 'endpoint' : 'page';
  const prerender: HypRoutePrerender | undefined = prerendered
    ? {
        ...(route.revalidate !== undefined ? { revalidate: route.revalidate } : {}),
        ...(prerenderedPaths.length
          ? { paths: prerenderedPaths.slice(0, 200), pathCount: prerenderedPaths.length }
          : {}),
      }
    : undefined;
  return {
    id: routeId(kind, pathname),
    pathname,
    regex: route.regex ?? routePatternToRegex(pathname),
    kind,
    classification,
    runtime: 'nodejs',
    dynamic,
    ...(prerender ? { prerender } : {}),
    assets: { js: [], css: [], fonts: [] },
    ...(route.sourcePage ? { sourcePage: route.sourcePage } : {}),
    ...(route.fallback ? { fallback: true } : {}),
  };
}

const escapeLiteral = (segment: string) => segment;

/**
 * React Router / Remix / Express-style paths: `:id` → `[id]`, `:lang?` → `[[lang]]`, `*` → `[...splat]`.
 * Optional static segments (`about?`) become an optional parameter named after the segment.
 */
export function fromColonPath(path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  const out = segments.map((seg) => {
    if (seg === '*') return '[...splat]';
    const m = /^:([A-Za-z0-9_$-]+)(\?)?$/.exec(seg);
    if (m) return m[2] ? `[[${m[1]}]]` : `[${m[1]}]`;
    if (seg.endsWith('?')) return `[[${seg.slice(0, -1).replace(/[^A-Za-z0-9_]/g, '_')}]]`;
    return escapeLiteral(seg);
  });
  return normalizePathname(out.join('/'));
}

/**
 * TanStack Router paths: `$id` → `[id]`, `$` → `[...splat]`, `{-$lang}` → `[[lang]]`, `{$id}.json` → `[id]`
 * (prefix/suffix segments match as a parameter), pathless `_layout` segments and `(group)` folders removed.
 */
export function fromTanStackPath(path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (const seg of segments) {
    if (/^\(.+\)$/.test(seg) || (seg.startsWith('_') && seg !== '_')) continue;
    if (seg === '$') {
      out.push('[...splat]');
      continue;
    }
    let m = /^\{-\$([A-Za-z0-9_]+)\}$/.exec(seg);
    if (m) {
      out.push(`[[${m[1]}]]`);
      continue;
    }
    m = /^\$([A-Za-z0-9_]+)$/.exec(seg);
    if (m) {
      out.push(`[${m[1]}]`);
      continue;
    }
    m = /\{\$([A-Za-z0-9_]+)\}/.exec(seg);
    if (m) {
      out.push(`[${m[1]}]`);
      continue;
    }
    out.push(seg.replace(/_$/, ''));
  }
  return normalizePathname(out.join('/'));
}

/**
 * Vue Router (Nuxt) paths: `/:id()` / `/:id` → `[id]`, `/:id?` → `[[id]]`, `/:slug(.*)*` → `[[...slug]]`,
 * `/:slug(.*)+` → `[...slug]`.
 */
export function fromVueRouterPath(path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  const out = segments.map((seg) => {
    const m = /^:([A-Za-z0-9_]+)(?:\(([^)]*)\))?([?*+])?$/.exec(seg);
    if (!m) return seg;
    const [, name, pattern, modifier] = m;
    const catchAll = pattern === '.*' || modifier === '*' || modifier === '+';
    if (catchAll) return modifier === '+' ? `[...${name}]` : `[[...${name}]]`;
    return modifier === '?' ? `[[${name}]]` : `[${name}]`;
  });
  return normalizePathname(out.join('/'));
}

/**
 * SvelteKit route ids: groups `(app)` removed, matchers `[id=integer]` → `[id]`, `[[lang]]` and `[...rest]` kept.
 */
export function fromSvelteKitId(id: string): string {
  const out = id
    .split('/')
    .filter((s) => s !== '' && !/^\(.+\)$/.test(s))
    .map((seg) => seg.replace(/\[(\[?)(\.\.\.)?([^\]=]+)=[^\]]+\](\]?)/g, '[$1$2$3$4]'));
  return normalizePathname(out.join('/'));
}

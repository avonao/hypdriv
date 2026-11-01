import { relative } from 'node:path';
import { createRouteMatcher } from '@hypdriv/core';
import { type DiscoveredRoute, normalizePathname, toHypRoute } from '@hypdriv/vite';

/**
 * A route as Qwik Router's Vite plugin reports it (`vite-plugin-qwik-router`'s `api.getRoutes()`): only the
 * fields Hypdriv reads. `routeName` is the pathname pattern (`/blog/[slug]/`, `/docs/[...path]/`).
 */
export interface QwikBuiltRoute {
  id: string;
  /** Absolute path of the route module. */
  filePath: string;
  /** Extension of the route module (`.tsx`, `.ts`, `.md`, `.mdx`…). */
  ext: string;
  pathname: string;
  routeName: string;
  pattern?: RegExp;
  segments?: Array<Array<{ content: string; dynamic: boolean; rest: boolean }>>;
}

/** Extensions of route modules that render a page (Qwik's `isPageExt`); everything else is an endpoint. */
const PAGE_EXTENSIONS = new Set(['.tsx', '.jsx', '.md', '.mdx']);

/** Whether a route module renders a page (a component, Markdown or MDX) or is a plain endpoint. */
export function isPageExtension(ext: string): boolean {
  return PAGE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Whether the route's pattern has a segment Hypdriv's canonical syntax cannot express (a parameter next to
 * literal text: `[id].json`, `post-[slug]`). The route then carries Qwik's own matcher.
 */
function hasPartialSegment(route: QwikBuiltRoute): boolean {
  return (route.segments ?? []).some((segment) => segment.length > 1 && segment.some((part) => part.dynamic));
}

export interface DiscoverRoutesOptions {
  /** Project root, for the relative `sourcePage`. */
  root: string;
}

/**
 * Hypdriv routes from Qwik Router's route table. `.tsx` / `.jsx` / `.md` / `.mdx` modules are pages (server-rendered
 * per request unless the build prerenders them, which the manifest learns from the documents Qwik's static
 * generation wrote), `.ts` / `.js` modules are endpoints (`onGet`, `onPost`, …). The trailing slash of Qwik's route
 * names is dropped (`/about/` → `/about`); the manifest records whether the app uses trailing slashes.
 */
export function discoverRoutes(routes: QwikBuiltRoute[], options: DiscoverRoutesOptions): DiscoveredRoute[] {
  const seen = new Set<string>();
  const out: DiscoveredRoute[] = [];
  for (const route of routes) {
    const kind = isPageExtension(route.ext) ? 'page' : 'endpoint';
    const pathname = normalizePathname(route.routeName || route.pathname);
    const key = `${kind}:${pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pathname,
      kind,
      sourcePage: relative(options.root, route.filePath).split('\\').join('/'),
      frameworkId: route.id,
      ...(hasPartialSegment(route) && route.pattern ? { regex: route.pattern.source } : {}),
    });
  }
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname) || a.kind.localeCompare(b.kind));
}

/** Adds the routes of the `routes` option to the discovered ones (a route given by the option wins). */
export function mergeRoutes(
  discovered: DiscoveredRoute[],
  option: DiscoveredRoute[] | ((discovered: DiscoveredRoute[]) => DiscoveredRoute[]) | undefined,
): DiscoveredRoute[] {
  if (!option) return discovered;
  if (typeof option === 'function') return option(discovered);
  const extra = new Set(option.map((r) => `${r.kind}:${normalizePathname(r.pathname)}`));
  return [...discovered.filter((r) => !extra.has(`${r.kind}:${normalizePathname(r.pathname)}`)), ...option];
}

/**
 * Gives every prerendered document that a dynamic page route matches (`/blog/hello` from `/blog/[slug]`'s
 * `onStaticGenerate`) a static page route of its own. The documents are files the platform's static layer serves
 * as they were built, so their policy has to be a hash policy of exactly that file, and the route that owns the
 * remaining paths (`/blog/other`, rendered per request with a nonce) stays dynamic. Documents no route matches
 * become static routes anyway (the manifest's own rule), so only matched ones are added here. Returns the routes
 * unchanged when there is nothing to promote.
 */
export function promotePrerendered(routes: DiscoveredRoute[], documents: string[]): DiscoveredRoute[] {
  if (!documents.length) return routes;
  const known = new Set(routes.filter((r) => r.kind === 'page').map((r) => normalizePathname(r.pathname)));
  const pages = routes.filter((r) => r.kind === 'page');
  const matcher = createRouteMatcher({
    routes: pages.map((r) => toHypRoute(r)),
    basePath: '',
    trailingSlash: false,
  });
  const added: DiscoveredRoute[] = [];
  for (const document of documents) {
    const pathname = normalizePathname(document);
    if (known.has(pathname)) continue;
    const hit = matcher.match(pathname);
    if (hit?.route.kind !== 'page') continue;
    known.add(pathname);
    const owner = pages.find((r) => toHypRoute(r).id === hit.route.id);
    added.push({
      pathname,
      kind: 'page',
      prerendered: true,
      ...(owner?.sourcePage ? { sourcePage: owner.sourcePage } : {}),
      ...(owner?.frameworkId ? { frameworkId: owner.frameworkId } : {}),
    });
  }
  return added.length ? [...routes, ...added].sort(byPathname) : routes;
}

const byPathname = (a: DiscoveredRoute, b: DiscoveredRoute): number =>
  a.pathname.localeCompare(b.pathname) || a.kind.localeCompare(b.kind);

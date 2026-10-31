import { isAbsolute, relative } from 'node:path';
import { type DiscoveredRoute, fromVueRouterPath, normalizePathname } from '@hypdriv/vite';

/** A page as Nuxt resolves it (`pages:resolved`): Vue Router path, source file, nested children. */
export interface NuxtPageLike {
  path: string;
  name?: string;
  file?: string;
  children?: NuxtPageLike[];
}

/** A Nitro server handler (`nitro.scannedHandlers`, `nitro.options.handlers`). */
export interface NitroHandlerLike {
  route?: string;
  method?: string;
  middleware?: boolean;
  handler?: string;
  lazy?: boolean;
}

/** A page with its full Vue Router path (children resolved against their parents). */
export interface FlatPage {
  path: string;
  name?: string;
  file?: string;
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child;
  if (!child) return parent || '/';
  return `${parent.replace(/\/+$/, '')}/${child}`;
}

/** Flattens Nuxt's page tree into full paths (a parent and its index child share one path; the child wins). */
export function flattenPages(pages: NuxtPageLike[], parent = ''): FlatPage[] {
  const out = new Map<string, FlatPage>();
  const visit = (list: NuxtPageLike[], base: string) => {
    for (const page of list) {
      const path = normalizePathname(joinRoutePath(base, page.path));
      const entry: FlatPage = {
        path,
        ...(page.name ? { name: page.name } : {}),
        ...(page.file ? { file: page.file } : {}),
      };
      // Index children render the parent's path: keep the more specific (child) source for it.
      if (!out.has(path) || !page.children?.length) out.set(path, entry);
      if (page.children?.length) visit(page.children, path);
    }
  };
  visit(pages, parent);
  return [...out.values()];
}

/** Nuxt pages as Hypdriv routes (canonical `[param]` patterns). */
export function pageRoutes(pages: NuxtPageLike[], rootDir: string): DiscoveredRoute[] {
  const seen = new Set<string>();
  const out: DiscoveredRoute[] = [];
  for (const page of flattenPages(pages)) {
    const pathname = fromVueRouterPath(page.path);
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    const sourcePage =
      page.file && isAbsolute(page.file) ? relative(rootDir, page.file).replace(/\\/g, '/') : page.file;
    out.push({
      pathname,
      kind: 'page',
      ...(sourcePage ? { sourcePage } : {}),
      ...(page.name ? { frameworkId: page.name } : {}),
    });
  }
  return out;
}

/**
 * Nitro (radix3) route syntax → canonical: `/users/:id` → `/users/[id]`, `/files/**:path` → `/files/[[...path]]`,
 * `/proxy/**` → `/proxy/[[...path]]`, `/a/*` → `/a/[_]`.
 */
export function fromNitroRoute(route: string): string {
  const segments = route.split('/').filter((s) => s !== '');
  let unnamed = 0;
  const out = segments.map((seg) => {
    const catchAll = /^\*\*(?::([A-Za-z0-9_]+))?$/.exec(seg);
    if (catchAll) return `[[...${catchAll[1] ?? 'path'}]]`;
    if (seg === '*') return `[_${unnamed++ || ''}]`;
    const param = /^:([A-Za-z0-9_]+)$/.exec(seg);
    if (param) return `[${param[1]}]`;
    return seg;
  });
  return normalizePathname(out.join('/'));
}

/** Paths Nuxt and Nitro serve for their own machinery (error rendering, islands, build assets). */
export function isInternalRoute(route: string, buildAssetsPath = '/_nuxt/'): boolean {
  return (
    route.startsWith('/__nuxt') ||
    route.startsWith(buildAssetsPath) ||
    route.startsWith('/_nuxt/') ||
    route === '/**' ||
    route === '/_ipx/**'
  );
}

/** Nitro's server routes (API routes, `server/routes`, module handlers) as Hypdriv endpoints. */
export function serverRoutes(
  handlers: NitroHandlerLike[],
  options: { exclude?: Array<string | undefined>; buildAssetsPath?: string } = {},
): DiscoveredRoute[] {
  const excluded = new Set(options.exclude?.filter(Boolean));
  const seen = new Set<string>();
  const out: DiscoveredRoute[] = [];
  for (const handler of handlers) {
    if (handler.middleware || !handler.route) continue;
    if (handler.handler && excluded.has(handler.handler)) continue;
    if (isInternalRoute(handler.route, options.buildAssetsPath)) continue;
    const pathname = fromNitroRoute(handler.route);
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    out.push({ pathname, kind: 'endpoint', frameworkId: handler.route });
  }
  return out;
}

/**
 * Every route of the app: pages first (they win over an endpoint with the same pattern), then server routes. An
 * app without `pages/` renders `app.vue` for every path: one catch-all page.
 */
export function discoverRoutes(input: {
  pages: NuxtPageLike[] | null;
  handlers: NitroHandlerLike[];
  rootDir: string;
  /** Handler files that are Nuxt's renderer (excluded: the pages describe what it renders). */
  renderers?: Array<string | undefined>;
  buildAssetsPath?: string;
}): DiscoveredRoute[] {
  const pages: DiscoveredRoute[] = input.pages?.length
    ? pageRoutes(input.pages, input.rootDir)
    : [{ pathname: '/[[...path]]', kind: 'page' }];
  const taken = new Set(pages.map((p) => p.pathname));
  const endpoints = serverRoutes(input.handlers, {
    exclude: input.renderers ?? [],
    ...(input.buildAssetsPath ? { buildAssetsPath: input.buildAssetsPath } : {}),
  }).filter((r) => !taken.has(r.pathname));
  return [...pages, ...endpoints];
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RouteAssetSources } from '@hypdriv/build';
import { type DiscoveredRoute, fromColonPath, normalizePathname } from '@hypdriv/vite';

/** A route of React Router's resolved route manifest (`reactRouterConfig.routes`). */
export interface RouteManifestEntryLike {
  id: string;
  parentId?: string;
  path?: string;
  index?: boolean;
  /** Module path relative to the app directory. */
  file: string;
  caseSensitive?: boolean;
}

/** A route of the browser manifest React Router writes into the client build (`assets/manifest-<hash>.js`). */
export interface BrowserManifestRoute {
  id: string;
  parentId?: string;
  path?: string;
  index?: boolean;
  hasLoader?: boolean;
  hasAction?: boolean;
  hasDefaultExport?: boolean;
  hasErrorBoundary?: boolean;
  module: string;
  imports?: string[];
  css?: string[];
}

/** React Router's browser manifest (`window.__reactRouterManifest`). */
export interface BrowserManifest {
  version?: string;
  entry: { module: string; imports?: string[]; css?: string[] };
  routes: Record<string, BrowserManifestRoute>;
}

/** Parses the source of `manifest-<hash>.js` (`window.__reactRouterManifest={…};`). */
export function parseBrowserManifest(source: string): BrowserManifest | null {
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as Partial<BrowserManifest>;
    if (!parsed || typeof parsed !== 'object' || !parsed.routes || !parsed.entry) return null;
    return parsed as BrowserManifest;
  } catch {
    return null;
  }
}

/**
 * Reads the browser manifest of a client build: `<clientDir>/<assetsDir>/manifest-<hash>.js` (the newest one when a
 * stale build left several). Null when the build has none.
 */
export function readBrowserManifest(clientDir: string, assetsDir = 'assets'): BrowserManifest | null {
  const dir = join(clientDir, assetsDir);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => /^manifest-[A-Za-z0-9_-]+\.js$/.test(f))
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    const manifest = parseBrowserManifest(readFileSync(file, 'utf8'));
    if (manifest) return manifest;
  }
  return null;
}

/** The URL path of a route: its own `path` joined to its ancestors' (`""` for the root and index routes). */
export function routePath(routes: Record<string, RouteManifestEntryLike>, id: string): string {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: RouteManifestEntryLike | undefined = routes[id];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.path) segments.unshift(current.path);
    current = current.parentId ? routes[current.parentId] : undefined;
  }
  return segments
    .join('/')
    .split('/')
    .filter((s) => s !== '')
    .join('/');
}

/** Normalises a React Router `basename` (`/`, `/app/`, `app`) to a path prefix without trailing slash (`''`, `/app`). */
export function basenamePrefix(basename: string | undefined): string {
  if (!basename) return '';
  const p = normalizePathname(basename);
  return p === '/' ? '' : p;
}

/** A React Router route path in Hypdriv's canonical pattern syntax, under the app's `basename`. */
export function routePattern(path: string, basename?: string): string {
  const pattern = fromColonPath(path);
  const prefix = basenamePrefix(basename);
  return normalizePathname(prefix + (pattern === '/' ? '' : pattern) || '/');
}

/** Ancestors of a route (root first), the route itself last. */
function branchOf(routes: Record<string, RouteManifestEntryLike>, id: string): RouteManifestEntryLike[] {
  const branch: RouteManifestEntryLike[] = [];
  const seen = new Set<string>();
  let current: RouteManifestEntryLike | undefined = routes[id];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.unshift(current);
    current = current.parentId ? routes[current.parentId] : undefined;
  }
  return branch;
}

const DEFAULT_EXPORT =
  /\bexport\s+default\b|\bexport\s*\{[^}]*\bas\s+default\b|\bexport\s+(?:async\s+)?function\s+ErrorBoundary\b|\bexport\s+(?:const|let|var)\s+ErrorBoundary\b|\bexport\s*\{[^}]*\bErrorBoundary\b/;

/** Whether a route module renders UI, judged from its source (used when the browser manifest is unavailable). */
export function sourceRendersUi(source: string): boolean {
  return DEFAULT_EXPORT.test(source);
}

export interface DiscoverInput {
  /** `reactRouterConfig.routes`. */
  routes: Record<string, RouteManifestEntryLike>;
  /** The client build's browser manifest: route kinds and per-route assets. */
  browser?: BrowserManifest | null;
  /** `reactRouterConfig.basename`. */
  basename?: string;
  /** Absolute app directory (route files are relative to it). */
  appDirectory?: string;
  /** Project root, for `sourcePage` paths. */
  root?: string;
}

export interface DiscoverResult {
  routes: DiscoveredRoute[];
  /** Pattern → React Router route id of the route that answers it. */
  routeIds: Record<string, string>;
  warnings: string[];
}

/**
 * Discovers the routes of a React Router app: one Hypdriv route per URL pattern (layouts and their index routes
 * share a pattern; the deepest route answers it). Routes without a default export or `ErrorBoundary` are resource
 * routes (`endpoint`); the browser manifest decides when available, the module source otherwise. Pages carry their
 * client assets: the entry, every route module of the branch, their imports and CSS.
 */
export function discoverRoutes(input: DiscoverInput): DiscoverResult {
  const { routes, browser } = input;
  const warnings: string[] = [];
  const children = new Map<string, number>();
  for (const route of Object.values(routes)) {
    if (route.parentId) children.set(route.parentId, (children.get(route.parentId) ?? 0) + 1);
  }
  const rendersUi = (route: RouteManifestEntryLike): boolean => {
    const entry = browser?.routes[route.id];
    if (entry) return entry.hasDefaultExport === true || entry.hasErrorBoundary === true;
    if (input.appDirectory) {
      try {
        return sourceRendersUi(readFileSync(join(input.appDirectory, route.file), 'utf8'));
      } catch {
        // unreadable module: assume a page
      }
    }
    return true;
  };

  // Candidates per pattern; the deepest route (index below its layout) answers the URL.
  const byPattern = new Map<string, { route: RouteManifestEntryLike; depth: number }>();
  for (const route of Object.values(routes)) {
    const isLayoutOnly = !route.index && !route.path && route.id !== 'root';
    if (isLayoutOnly) continue; // pathless layouts never answer a URL themselves
    const pattern = routePattern(routePath(routes, route.id), input.basename);
    const depth = branchOf(routes, route.id).length + (route.index ? 0.5 : 0);
    const current = byPattern.get(pattern);
    if (!current || depth > current.depth) byPattern.set(pattern, { route, depth });
  }

  const discovered: DiscoveredRoute[] = [];
  const routeIds: Record<string, string> = {};
  const rootRelative = (file: string) =>
    input.appDirectory
      ? relative(input.root ?? input.appDirectory, join(input.appDirectory, file)).replace(/\\/g, '/')
      : file;
  for (const [pattern, { route }] of [...byPattern.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const hasChildren = (children.get(route.id) ?? 0) > 0;
    const kind: DiscoveredRoute['kind'] = hasChildren || rendersUi(route) ? 'page' : 'endpoint';
    const item: DiscoveredRoute = {
      pathname: pattern,
      kind,
      sourcePage: rootRelative(route.file),
      frameworkId: route.id,
    };
    if (kind === 'page' && browser) {
      const sources = branchAssets(browser, branchOf(routes, route.id));
      if (sources) item.sources = sources;
    }
    discovered.push(item);
    routeIds[pattern] = route.id;
  }
  if (!browser && Object.keys(routes).length > 1)
    warnings.push(
      'react-router: the client build has no browser manifest (assets/manifest-*.js); route kinds come from the module sources and pages carry no asset lists',
    );
  return { routes: discovered, routeIds, warnings };
}

/** Client assets of a branch: the entry, each route module with its static imports, and their CSS. */
export function branchAssets(
  browser: BrowserManifest,
  branch: Array<Pick<RouteManifestEntryLike, 'id'>>,
): RouteAssetSources | null {
  const js: string[] = [];
  const css: string[] = [];
  const main: string[] = [];
  const add = (list: string[], values: string[] | undefined) => {
    for (const v of values ?? []) if (v && !list.includes(v)) list.push(v);
  };
  add(js, [browser.entry.module]);
  add(main, [browser.entry.module]);
  add(js, browser.entry.imports);
  add(css, browser.entry.css);
  for (const { id } of branch) {
    const route = browser.routes[id];
    if (!route) continue;
    add(js, [route.module]);
    add(main, [route.module]);
    add(js, route.imports);
    add(css, route.css);
  }
  if (!js.length && !css.length) return null;
  return { js, css, fonts: [], main };
}

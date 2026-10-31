import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type DiscoveredRoute, normalizePathname } from '@hypdriv/vite';

/** File extensions vinext accepts for pages, layouts and route handlers (Next.js defaults plus MDX). */
export const PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mdx', 'md'] as const;

/** The router directories of a vinext project. */
export interface RouterDirs {
  /** The App Router directory (`app/` or `src/app/`), when present. */
  appDir: string | null;
  /** The Pages Router directory (`pages/` or `src/pages/`), when present. */
  pagesDir: string | null;
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Finds `app/` and `pages/` like vinext does: in `base` (vinext's `appDir` option, default the project root),
 * falling back to `src/`.
 */
export function findRouterDirs(root: string, base?: string): RouterDirs {
  const dir = base ? (isAbsolute(base) ? base : resolve(root, base)) : root;
  const pick = (name: string): string | null => {
    if (isDir(join(dir, name))) return join(dir, name);
    if (!base && isDir(join(root, 'src', name))) return join(root, 'src', name);
    return null;
  };
  return { appDir: pick('app'), pagesDir: pick('pages') };
}

/** Segment config read from a page or route handler source (`export const revalidate = 60`). */
export interface SegmentConfig {
  revalidate?: number | false;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
}

const REVALIDATE = /export\s+const\s+revalidate\s*(?::[^=]+)?=\s*(false|Infinity|\d[\d_]*(?:\.\d+)?)\b/;
const DYNAMIC = /export\s+const\s+dynamic\s*(?::[^=]+)?=\s*['"`](auto|force-dynamic|force-static|error)['"`]/;

/** Reads `revalidate` and `dynamic` segment config from a module's source text. */
export function readSegmentConfig(source: string): SegmentConfig {
  const out: SegmentConfig = {};
  const revalidate = REVALIDATE.exec(source)?.[1];
  if (revalidate === 'false' || revalidate === 'Infinity') out.revalidate = false;
  else if (revalidate !== undefined) out.revalidate = Number(revalidate.replace(/_/g, ''));
  const dynamic = DYNAMIC.exec(source)?.[1] as SegmentConfig['dynamic'] | undefined;
  if (dynamic) out.dynamic = dynamic;
  return out;
}

function segmentConfigOf(file: string): SegmentConfig {
  try {
    return readSegmentConfig(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const fileStem = (name: string, extensions: readonly string[]): string | null => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return extensions.includes(name.slice(dot + 1)) ? name.slice(0, dot) : null;
};

/**
 * The URL segment an App Router folder contributes: `null` for folders that are not part of the URL (route
 * groups, parallel-route slots), `false` for folders whose whole subtree is not routable (private folders,
 * intercepting routes).
 */
export function appSegment(folder: string): string | null | false {
  if (folder.startsWith('_')) return false;
  if (/^\((?:\.{1,3}|\.\.\)\(\.\.)\)/.test(folder)) return false;
  if (/^\(.+\)$/.test(folder)) return null;
  if (folder.startsWith('@')) return null;
  return folder.replace(/%5F/gi, '_');
}

const METADATA_ROUTES: Array<{ stem: string; extensions: string[]; path: string; rootOnly?: boolean }> = [
  { stem: 'sitemap', extensions: ['xml', 'ts', 'js', 'tsx', 'jsx'], path: 'sitemap.xml' },
  { stem: 'robots', extensions: ['txt', 'ts', 'js', 'tsx', 'jsx'], path: 'robots.txt', rootOnly: true },
  {
    stem: 'manifest',
    extensions: ['webmanifest', 'json', 'ts', 'js', 'tsx', 'jsx'],
    path: 'manifest.webmanifest',
    rootOnly: true,
  },
];

function metadataRoute(name: string, segments: string[]): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  for (const m of METADATA_ROUTES) {
    if (m.stem !== stem || !m.extensions.includes(ext)) continue;
    if (m.rootOnly && segments.length) return null;
    // A static manifest keeps its own extension (`manifest.json`); generated ones are served as `.webmanifest`.
    const file = m.stem === 'manifest' && (ext === 'json' || ext === 'webmanifest') ? name : m.path;
    return normalizePathname(`/${[...segments, file].join('/')}`);
  }
  return null;
}

/** A folder's entries: files first (a segment's own page wins over its parallel slots), then folders, by name. */
function readDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }
}

/**
 * Discovers the routes of an App Router directory with Next.js conventions: `page.*` (pages), `route.*`
 * (Route Handlers), dynamic segments (`[id]`, `[...slug]`, `[[...slug]]`, already Hypdriv's canonical syntax),
 * route groups and parallel-route slots (not part of the URL), private folders and intercepting routes (not
 * routable), and the `sitemap` / `robots` / `manifest` metadata routes.
 */
export function discoverAppRoutes(
  appDir: string,
  options: { root?: string; extensions?: readonly string[] } = {},
): DiscoveredRoute[] {
  const extensions = options.extensions ?? PAGE_EXTENSIONS;
  const root = options.root ?? appDir;
  const found = new Map<string, DiscoveredRoute>();
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const segment = appSegment(entry.name);
        if (segment === false) continue;
        walk(full, segment === null ? segments : [...segments, segment]);
        continue;
      }
      if (!entry.isFile()) continue;
      const pathname = normalizePathname(`/${segments.join('/')}`);
      const stem = fileStem(entry.name, extensions);
      if (stem === 'page' || stem === 'route') {
        const kind = stem === 'page' ? 'page' : 'endpoint';
        const id = `${kind}:${pathname}`;
        // A parallel slot's page renders inside its parent's page: the parent route is the URL's route.
        if (found.has(id)) continue;
        const segment = segmentConfigOf(full);
        found.set(id, {
          pathname,
          kind,
          sourcePage: relative(root, full).split('\\').join('/'),
          ...(typeof segment.revalidate === 'number' &&
          segment.revalidate > 0 &&
          segment.dynamic !== 'force-dynamic'
            ? { revalidate: segment.revalidate }
            : {}),
          frameworkId: `app${pathname === '/' ? '' : pathname}/${stem}`,
        });
        continue;
      }
      const metadata = metadataRoute(entry.name, segments);
      if (metadata && !found.has(`endpoint:${metadata}`))
        found.set(`endpoint:${metadata}`, {
          pathname: metadata,
          kind: 'endpoint',
          sourcePage: relative(root, full).split('\\').join('/'),
          frameworkId: `app${metadata}`,
        });
    }
  };
  if (existsSync(appDir)) walk(appDir, []);
  return [...found.values()];
}

const PAGES_SPECIAL = new Set(['_app', '_document', '_error', '404', '500']);

/**
 * Discovers the routes of a Pages Router directory: `index` files, dynamic segments, `api/**` as endpoints;
 * `_app`, `_document`, `_error`, `404` and `500` are not routes of their own.
 */
export function discoverPagesRoutes(
  pagesDir: string,
  options: { root?: string; extensions?: readonly string[] } = {},
): DiscoveredRoute[] {
  const extensions = options.extensions ?? PAGE_EXTENSIONS;
  const root = options.root ?? pagesDir;
  const out: DiscoveredRoute[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, [...segments, entry.name]);
        continue;
      }
      if (!entry.isFile()) continue;
      const stem = fileStem(entry.name, extensions);
      if (!stem) continue;
      if (!segments.length && PAGES_SPECIAL.has(stem)) continue;
      const parts = stem === 'index' ? segments : [...segments, stem];
      const pathname = normalizePathname(`/${parts.join('/')}`);
      const api = segments[0] === 'api';
      out.push({
        pathname,
        kind: api ? 'endpoint' : 'page',
        sourcePage: relative(root, full).split('\\').join('/'),
        frameworkId: `pages${pathname === '/' ? '' : pathname}`,
      });
    }
  };
  if (existsSync(pagesDir)) walk(pagesDir, []);
  return out;
}

/** Every route of the project (App Router routes win over Pages Router routes with the same path). */
export function discoverRoutes(root: string, dirs: RouterDirs): DiscoveredRoute[] {
  const app = dirs.appDir ? discoverAppRoutes(dirs.appDir, { root }) : [];
  const pages = dirs.pagesDir ? discoverPagesRoutes(dirs.pagesDir, { root }) : [];
  const seen = new Set(app.map((r) => `${r.kind}:${r.pathname}`));
  return [...app, ...pages.filter((r) => !seen.has(`${r.kind}:${r.pathname}`))];
}

/**
 * vinext's route patterns (`/blog/:slug`, `/docs/:path+`, `/shop/:path*`) in Hypdriv's canonical syntax
 * (`/blog/[slug]`, `/docs/[...path]`, `/shop/[[...path]]`).
 */
export function fromVinextPattern(pattern: string): string {
  const out = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const m = /^:([A-Za-z0-9_$-]+)([+*?])?$/.exec(segment);
      if (!m) return segment;
      const [, name, modifier] = m;
      if (modifier === '+') return `[...${name}]`;
      if (modifier === '*') return `[[...${name}]]`;
      if (modifier === '?') return `[[${name}]]`;
      return `[${name}]`;
    });
  return normalizePathname(`/${out.join('/')}`);
}

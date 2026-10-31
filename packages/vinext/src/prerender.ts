import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePathname } from '@hypdriv/vite';
import { fromVinextPattern } from './routes';

/** One route of vinext's `dist/server/vinext-prerender.json`. */
export interface VinextPrerenderRoute {
  /** vinext's route pattern (`/blog/:slug`). */
  route: string;
  status?: string;
  reason?: string;
  revalidate?: number | false;
  expire?: number;
  /** The concrete pathname, for dynamic routes. */
  path?: string;
  router?: string;
  fallback?: boolean;
  responseStatus?: number;
  notFound?: true;
  redirectProps?: object;
  tags?: string[];
}

/** vinext's prerender index. */
export interface VinextPrerenderManifest {
  buildId?: string;
  trailingSlash?: boolean;
  routes?: VinextPrerenderRoute[];
}

/** Reads `vinext-prerender.json` from vinext's server directory (`dist/server`); null without a prerender. */
export function readPrerenderManifest(serverDir: string): VinextPrerenderManifest | null {
  const file = join(serverDir, 'vinext-prerender.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as VinextPrerenderManifest;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The file vinext writes a prerendered document to (relative to `prerendered-routes/`), as vinext's
 * `getOutputPath` maps it: `/` → `index.html`, `/about` → `about.html` (`about/index.html` with
 * `trailingSlash`), `/index` → `index/index.html`, prefixed with the base path.
 */
export function prerenderOutputPath(pathname: string, trailingSlash: boolean, basePath = ''): string {
  if (pathname === '/' && basePath === '') return 'index.html';
  const own = /^\/index(?:\/|$)/.test(pathname) ? `/index${pathname}` : pathname;
  const url =
    basePath === ''
      ? own
      : pathname === '/'
        ? trailingSlash
          ? `${basePath}/`
          : basePath
        : `${basePath}${own}`;
  const clean = url.replace(/^\//, '').replace(/\/$/, '');
  return trailingSlash ? `${clean}/index.html` : `${clean}.html`;
}

/** Pathnames of error documents, which are never served as a page of their own. */
const ERROR_DOCUMENTS = new Set(['/404', '/500', '/_error', '/_not-found', '/_global-error']);

/** A page vinext prerendered at build time. */
export interface PrerenderedPage {
  /** The concrete pathname (`/blog/hello`). */
  pathname: string;
  /** The route in HypDriv's canonical syntax (`/blog/[slug]`). */
  pattern: string;
  /** The HTML document. */
  file: string;
  /** Seconds between regenerations, or `false` (never). */
  revalidate: number | false;
  /** Cache tags the application attached (`cacheTag()`, `fetch` tags), without vinext's implicit path tags. */
  tags: string[];
  router: string;
}

/** Tags vinext derives from the path (`_N_T_/blog`, `/blog`); everything else was set by the application. */
export function explicitTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter(
    (t) => typeof t === 'string' && t && !t.startsWith('_N_T_') && !t.startsWith('/'),
  );
}

/**
 * The pages vinext rendered to HTML (App and Pages Router; not metadata routes, error documents, fallback
 * shells, redirects or non-200 documents), with the file each was written to.
 */
export function prerenderedPages(
  serverDir: string,
  manifest: VinextPrerenderManifest | null,
  options: { basePath?: string } = {},
): PrerenderedPage[] {
  if (!manifest?.routes?.length) return [];
  const trailingSlash = manifest.trailingSlash === true;
  const out: PrerenderedPage[] = [];
  const seen = new Set<string>();
  for (const route of manifest.routes) {
    if (route.status !== 'rendered') continue;
    if (route.router !== 'app' && route.router !== 'pages') continue;
    if (route.fallback || route.notFound || route.redirectProps) continue;
    if (route.responseStatus !== undefined && route.responseStatus !== 200) continue;
    const pathname = normalizePathname(route.path ?? route.route);
    if (ERROR_DOCUMENTS.has(pathname) || seen.has(pathname)) continue;
    const file = join(
      serverDir,
      'prerendered-routes',
      prerenderOutputPath(pathname, trailingSlash, options.basePath),
    );
    if (!existsSync(file)) continue;
    seen.add(pathname);
    out.push({
      pathname,
      pattern: fromVinextPattern(route.route),
      file,
      revalidate:
        typeof route.revalidate === 'number' && route.revalidate > 0 && Number.isFinite(route.revalidate)
          ? route.revalidate
          : false,
      tags: explicitTags(route.tags),
      router: route.router,
    });
  }
  return out;
}

/** SHA-256 (hex) of a file's bytes, or null when unreadable. */
export function fileDigest(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Content digests of the HTML documents vinext's `staticAssetsAdapter()` packaged into Workers Static Assets
 * (`_vinext/static-cache/<id>.html`, listed in its `index.json`), or null when the build has no static cache. A
 * prerendered page whose bytes are in this set is served on Workers exactly as built.
 */
export function staticCacheDigests(clientDir: string): Set<string> | null {
  const dir = join(clientDir, '_vinext', 'static-cache');
  const file = join(dir, 'index.json');
  if (!existsSync(file)) return null;
  try {
    const index = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { kind?: string }>;
    const digests = new Set<string>();
    for (const [id, entry] of Object.entries(index)) {
      if (entry?.kind !== 'html' || !/^[0-9a-f]+$/i.test(id)) continue;
      const digest = fileDigest(join(dir, `${id}.html`));
      if (digest) digests.add(digest);
    }
    return digests;
  } catch {
    return null;
  }
}

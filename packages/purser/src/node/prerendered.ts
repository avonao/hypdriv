import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { cleanRoutePathname, type Logger, silentLogger } from '@hypdriv/core';

export interface CollectPrerenderedOptions {
  /** Also read `*.rsc` / `*.prefetch.rsc` payloads and append them to the route's text. Default false. */
  includeRsc?: boolean;
  /** Maximum number of files read (default 2000). */
  maxFiles?: number;
  /** Maximum size per file in bytes (default 2 MB); larger files are skipped with a warning. */
  maxBytes?: number;
  log?: Logger;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/** `/index.html` → `/`, `/blog/[slug].html` → `/blog/[slug]`, `/(group)/x.html` → `/x`. */
export function pathnameFromPrerenderFile(root: string, file: string, extension: string): string {
  let rel = relative(root, file).split(sep).join('/');
  rel = rel.slice(0, rel.length - extension.length);
  if (rel === 'index' || rel === '') return '/';
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  return cleanRoutePathname(`/${rel}`);
}

/**
 * Reads the prerendered documents of a Next.js build: `.next/server/app/**\/*.html`,
 * `.next/server/pages/**\/*.html` and (Next.js 16.4+) `.next/server/route-cache/APP_PAGE/*\/$/**`, keyed by the pathname derived from the file path (`/index.html`
 * → `/`, `/blog/[slug].html` stays the pattern path). With `includeRsc`, `*.rsc` and `*.prefetch.rsc`
 * payloads are appended to the same key so `className` strings in RSC output count for the route.
 * Reads at most `maxFiles` files of at most `maxBytes` each; keys are sorted. `distDir` is the `.next`
 * directory; a project directory containing `.next` is accepted too.
 */
export async function collectPrerenderedHtml(
  distDir: string,
  options: CollectPrerenderedOptions = {},
): Promise<Record<string, string>> {
  const log = options.log ?? silentLogger;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let root = resolve(distDir);
  if (!existsSync(join(root, 'server')) && existsSync(join(root, '.next', 'server')))
    root = join(root, '.next');
  const out: Record<string, string> = {};
  let count = 0;
  let truncated = false;

  // Next.js ≤ 16.3 writes prerenders next to the route modules (`server/app`, `server/pages`); 16.4 keeps
  // App Router prerenders in `server/route-cache/APP_PAGE/<hash>/$/…` (one root per route).
  const bases = [join(root, 'server', 'app'), join(root, 'server', 'pages')];
  const routeCache = join(root, 'server', 'route-cache', 'APP_PAGE');
  if (existsSync(routeCache)) {
    for (const entry of (await readdir(routeCache, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const base = join(routeCache, entry.name, '$');
      if (entry.isDirectory() && existsSync(base)) bases.push(base);
    }
  }

  for (const base of bases) {
    if (!existsSync(base)) continue;
    const files: string[] = [];
    await walk(base, files);
    for (const file of files) {
      if (file.includes('.segments')) continue;
      const isHtml = file.endsWith('.html');
      const isRsc = options.includeRsc === true && (file.endsWith('.rsc') || file.endsWith('.prefetch.rsc'));
      if (!isHtml && !isRsc) continue;
      if (count >= maxFiles) {
        truncated = true;
        break;
      }
      const size = (await stat(file)).size;
      if (size > maxBytes) {
        log.warn('purser: skipping prerendered file above the size limit', { file, size, maxBytes });
        continue;
      }
      count++;
      const ext = isHtml ? '.html' : file.endsWith('.prefetch.rsc') ? '.prefetch.rsc' : '.rsc';
      const pathname = pathnameFromPrerenderFile(base, file, ext);
      const text = await readFile(file, 'utf8');
      out[pathname] = out[pathname] ? `${out[pathname]}\n${text}` : text;
    }
    if (truncated) break;
  }
  if (truncated)
    log.warn('purser: prerendered file limit reached; later routes were not checked', { maxFiles });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

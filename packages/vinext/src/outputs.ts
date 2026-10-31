import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VercelRoute } from '@hypdriv/build';

/** A prerendered page copied into a platform's static output. */
export interface StaticPage {
  pathname: string;
  file: string;
}

interface VercelConfigJson {
  version: number;
  routes?: VercelRoute[];
  overrides?: Record<string, { path?: string; contentType?: string }>;
  [key: string]: unknown;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The function the Build Output's catch-all route renders with (Nitro: `/__server`). */
export function vercelFallbackDestination(routes: VercelRoute[]): string | null {
  const filesystem = routes.findIndex((r) => r.handle === 'filesystem');
  if (filesystem === -1) return null;
  for (const route of routes.slice(filesystem + 1)) {
    if (route.handle) break;
    if (route.dest && route.src && CATCH_ALL_SOURCES.has(route.src)) return route.dest;
  }
  return null;
}

const CATCH_ALL_SOURCES = new Set(['/(.*)', '^/(.*)$', '/.*', '^/.*$', '^/(?:.*)$', '^.*$']);

/**
 * Serves vinext's prerendered pages from Vercel's CDN: copies each document into `.vercel/output/static` (with an
 * `overrides` entry so `/about` serves `about.html`) and routes the requests a static file must not answer to the
 * application's function before the filesystem: RSC navigations (`RSC: 1`), Server Actions and other non-GET
 * methods. Returns the pages copied.
 */
export function writeVercelStaticPages(input: { outputDir: string; pages: StaticPage[] }): StaticPage[] {
  const configFile = join(input.outputDir, 'config.json');
  if (!existsSync(configFile) || !input.pages.length) return [];
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as VercelConfigJson;
  const routes = config.routes ?? [];
  const destination = vercelFallbackDestination(routes);
  if (!destination) return [];
  const staticDir = join(input.outputDir, 'static');
  const overrides = { ...(config.overrides ?? {}) };
  const copied: StaticPage[] = [];
  for (const page of input.pages) {
    const name = page.pathname === '/' ? 'index.html' : `${page.pathname.slice(1)}.html`;
    const target = join(staticDir, name);
    // Never shadow a public file of the same name.
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(page.file, target);
    if (page.pathname !== '/')
      overrides[name] = { path: page.pathname.slice(1), contentType: 'text/html; charset=utf-8' };
    copied.push(page);
  }
  if (!copied.length) return [];
  const alternatives = copied.map((p) => (p.pathname === '/' ? '' : escapeRegex(p.pathname.slice(1))));
  const src = `^/(?:${alternatives.join('|')})/?$`;
  const dynamicRoutes: VercelRoute[] = [
    { src, has: [{ type: 'header', key: 'rsc' }], dest: destination, check: true },
    { src, has: [{ type: 'header', key: 'next-action' }], dest: destination, check: true },
    { src, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], dest: destination, check: true },
  ];
  // Routes of an earlier run: rewrites to the function placed before the filesystem.
  const firstFs = routes.findIndex((r) => r.handle === 'filesystem');
  const kept = routes.filter(
    (r, i) => !(r.dest === destination && r.check === true && (firstFs === -1 || i < firstFs)),
  );
  const filesystem = kept.findIndex((r) => r.handle === 'filesystem');
  const at = filesystem === -1 ? kept.length : filesystem;
  config.routes = [...kept.slice(0, at), ...dynamicRoutes, ...kept.slice(at)];
  config.overrides = overrides;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return copied;
}

/** Function directories of a Build Output (`.vercel/output/functions/**\/*.func`). */
export function vercelFunctionDirs(outputDir: string): string[] {
  const root = join(outputDir, 'functions');
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name.endsWith('.func')) out.push(full);
      else walk(full);
    }
  };
  walk(root);
  return out;
}

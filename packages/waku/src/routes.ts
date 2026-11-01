import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type DiscoveredRoute, normalizePathname } from '@hypdriv/vite';

/** File extensions Waku's file router and managed entry accept (`waku/dist/lib/constants`). */
export const PAGE_EXTENSIONS = ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs'] as const;

/** Directory names under `pages/` the file router does not turn into pages (`isIgnoredPath`). */
const IGNORED_PARTS = new Set(['_actions', '_components', '_hooks']);

export interface RouteDirs {
  /** `srcDir`, absolute. */
  srcDir: string;
  /** `pages` and the special directories, as the file router's options name them. */
  pagesDir?: string;
  apiDir?: string;
  slicesDir?: string;
  interceptorsDir?: string;
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
}

const EXTENSION = new RegExp(`\\.(?:${PAGE_EXTENSIONS.join('|')})$`);

/** `render` and `staticPaths` of a module, read from its `getConfig` source (the file router's `config`). */
export interface PageConfig {
  render?: 'static' | 'dynamic';
  /** Whether `getConfig` declares `staticPaths` (a slug page prerenders only those). */
  staticPaths: boolean;
}

/** Reads the segment config out of a page's source text without running it. */
export function readPageConfig(source: string): PageConfig {
  const code = stripComments(source);
  const render = /\brender\s*:\s*['"`](static|dynamic)['"`]/.exec(code)?.[1] as PageConfig['render'];
  return { ...(render ? { render } : {}), staticPaths: /\bstaticPaths\s*:/.test(code) };
}

/**
 * The URL pattern of a page file under `pages/`, in Hypdriv's syntax: `index` and `_layout` / `_root` contribute
 * nothing, `(group)` folders are removed, `[slug]` and `[...wild]` stay. `null` for files that are no pages.
 */
export function pagePattern(parts: string[]): string | null {
  if (parts.some((p) => IGNORED_PARTS.has(p))) return null;
  const last = parts.at(-1);
  if (last === '_layout' || last === '_root') return null;
  if (last === '[path]') return null;
  const segments = (last === 'index' ? parts.slice(0, -1) : parts).filter((p) => !/^\(.*\)$/.test(p));
  return normalizePathname(segments.join('/'));
}

/** Discovers the routes of Waku's file router (`src/pages`): pages, `_api` handlers; slices and layouts excluded. */
export function discoverFileRoutes(root: string, dirs: RouteDirs): DiscoveredRoute[] {
  const pagesName = dirs.pagesDir ?? 'pages';
  const apiName = dirs.apiDir ?? '_api';
  const slicesName = dirs.slicesDir ?? '_slices';
  const interceptorsName = dirs.interceptorsDir ?? '_interceptors';
  const pagesRoot = join(dirs.srcDir, pagesName);
  if (!isDir(pagesRoot)) return [];
  const files: string[] = [];
  walk(pagesRoot, files);
  const routes = new Map<string, DiscoveredRoute>();
  for (const file of files) {
    if (!EXTENSION.test(file) || file.endsWith('.d.ts')) continue;
    const parts = relative(pagesRoot, file).replace(EXTENSION, '').split(/[\\/]/).filter(Boolean);
    if (!parts.length || parts.some((p) => IGNORED_PARTS.has(p))) continue;
    if (parts[0] === slicesName || parts[0] === interceptorsName) continue;
    let source = '';
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      source = '';
    }
    const config = readPageConfig(source);
    const sourcePage = relative(root, file).split('\\').join('/');
    if (parts[0] === apiName) {
      // `_api/hello.ts` answers `/hello`: the directory name is stripped (the file's second extension is kept).
      const rest = parts.slice(1);
      if (!rest.length) continue;
      const pathname = normalizePathname(rest.join('/'));
      const isStatic = config.render === 'static';
      if (!routes.has(`endpoint:${pathname}`))
        routes.set(`endpoint:${pathname}`, {
          pathname,
          kind: 'endpoint',
          sourcePage,
          ...(isStatic && !/\[[^\]]+\]/.test(pathname) ? { prerendered: true } : {}),
        });
      continue;
    }
    const pathname = pagePattern(parts);
    if (pathname === null || routes.has(`page:${pathname}`)) continue;
    const dynamicPattern = /\[[^\]]+\]/.test(pathname);
    // A static page prerenders at build time; a slug page only for its `staticPaths`.
    const prerendered = (config.render ?? 'static') === 'static' && (!dynamicPattern || config.staticPaths);
    routes.set(`page:${pathname}`, {
      pathname,
      kind: 'page',
      sourcePage,
      ...(prerendered ? { prerendered: true } : {}),
    });
  }
  return [...routes.values()];
}

/** Index of the matching close character of the bracket at `open`, skipping strings and comments; -1 if none. */
function matching(source: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch] as string);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** The source with its comments blanked out (strings and template literals are left alone). */
export function stripComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += ch;
  }
  return out;
}

/** Waku's path syntax (`/blog/[slug]`, `/docs/[...rest]`) is Hypdriv's already; `(group)` folders are removed. */
function programmaticPattern(path: string): string {
  return normalizePathname(
    path
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s))
      .join('/'),
  );
}

/**
 * Routes registered with the programmatic router API (`createPages(({ createPage, createApi }) => …)` in
 * `src/waku.server.tsx`): the literal `path` and `render` of each `createPage({…})` / `createApi({…})` call.
 * Calls with computed paths are skipped (list those in the plugin's `routes` option).
 */
export function scanCreatePages(rawSource: string, sourcePage?: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const source = stripComments(rawSource);
  const call = /\b(createPage|createApi)\s*\(\s*\{/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const open = source.indexOf('{', match.index + match[0].length - 1);
    const close = matching(source, open);
    if (close < 0) continue;
    const body = source.slice(open, close + 1);
    const path = /\bpath\s*:\s*(['"`])([^'"`$]*)\1/.exec(body)?.[2];
    if (path === undefined || !path.startsWith('/')) continue;
    const config = readPageConfig(body);
    const kind = match[1] === 'createApi' ? 'endpoint' : 'page';
    const pathname = kind === 'page' ? programmaticPattern(path) : normalizePathname(path);
    const dynamicPattern = /\[[^\]]+\]/.test(pathname);
    const prerendered =
      kind === 'page'
        ? (config.render ?? 'static') === 'static' && (!dynamicPattern || config.staticPaths)
        : config.render === 'static' && !dynamicPattern;
    routes.push({
      pathname,
      kind,
      ...(sourcePage ? { sourcePage } : {}),
      ...(prerendered ? { prerendered: true } : {}),
    });
  }
  return routes;
}

/** Files that can hold a programmatic router (`src/waku.server.*`). */
export function serverEntryFiles(srcDir: string): string[] {
  return PAGE_EXTENSIONS.map((ext) => join(srcDir, `waku.server.${ext}`)).filter((f) => existsSync(f));
}

/**
 * Every route of a Waku project: the file router's (`src/pages`), plus the literal `createPage` / `createApi`
 * calls of a custom `src/waku.server.*`. A route found both ways keeps the file router's entry.
 */
export function discoverRoutes(root: string, dirs: RouteDirs): DiscoveredRoute[] {
  const routes = discoverFileRoutes(root, dirs);
  const seen = new Set(routes.map((r) => `${r.kind}:${r.pathname}`));
  for (const file of serverEntryFiles(dirs.srcDir)) {
    let source = '';
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const sourcePage = relative(root, file).split('\\').join('/');
    for (const route of scanCreatePages(source, sourcePage)) {
      const key = `${route.kind}:${route.pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(route);
    }
  }
  return routes;
}

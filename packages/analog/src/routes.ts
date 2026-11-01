import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PageAssets } from '@hypdriv/nitro';
import { assetsForEntries, type DiscoveredRoute, entriesForSources, normalizePathname } from '@hypdriv/vite';

/**
 * The URL path of an Analog route file, relative to the directory it was found in (`src/app/pages`,
 * `src/content`, an additional pages directory). Analog's file router rules: `index` segments and `(group)`
 * folders vanish, a dot in a name is a slash (`blog.[slug].page.ts` → `/blog/[slug]`), `[id]`, `[...rest]` and
 * `[[...rest]]` are parameters (Hypdriv's canonical pattern syntax is the same).
 *
 * ```
 * index.page.ts                → /
 * users/[id].page.ts           → /users/[id]
 * (auth)/login.page.ts         → /login
 * docs/[...slug].page.ts       → /docs/[...slug]
 * shop/[[...category]].page.ts → /shop/[[...category]]
 * ```
 */
export function analogRoutePath(fileInDirectory: string): string {
  let path = fileInDirectory
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.page\.(?:js|ts)$|\.(?:ts|md)$/, '');
  // Parameters keep their dots (`[...slug]`) and brackets through the substitutions below.
  const parameters: string[] = [];
  path = path.replace(/\[\[?\.{0,3}[^\]]*\]?\]/g, (match) => {
    parameters.push(match);
    return `\0${parameters.length - 1}\0`;
  });
  path = path
    .replace(/\(.*?\)/g, '')
    .replace(/(^|[./])index(?=[./]|$)/g, '$1')
    .replace(/\./g, '/');
  path = path.replace(/\0(\d+)\0/g, (_, index: string) => parameters[Number(index)] ?? '');
  return normalizePathname(path.split('/').filter(Boolean).join('/'));
}

/** Where an Analog project keeps its route files. */
export interface AnalogPagesOptions {
  /** The project root (the directory with `vite.config.ts`). */
  root: string;
  /** The workspace root, which `additional*Dirs` resolve against (default: `root`). */
  workspaceRoot?: string;
  /** Analog's `sourceRoot` (default `src`). */
  sourceRoot?: string;
  /** Analog's `additionalPagesDirs`: other directories with `*.page.ts` files (shared libraries). */
  additionalPagesDirs?: string[];
  /** Analog's `additionalContentDirs`: other directories with Markdown content routes. */
  additionalContentDirs?: string[];
  /**
   * Whether Markdown files are routes (`withContentRoutes()`): `src/app/pages/**.md` and `src/content/**.md`.
   * Default: when the project depends on `@analogjs/content`.
   */
  contentRoutes?: boolean;
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const visit = (current: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (accept(entry.name)) found.push(full);
    }
  };
  visit(dir);
  return found;
}

function resolveDir(dir: string, workspaceRoot: string): string {
  const normalized = dir.replace(/\\/g, '/');
  if (isAbsolute(dir) && (normalized === workspaceRoot || normalized.startsWith(`${workspaceRoot}/`)))
    return dir;
  // Analog reads a leading slash as relative to the workspace (`/libs/shared/src/pages`).
  if (normalized.startsWith('/')) return join(workspaceRoot, normalized);
  return resolve(workspaceRoot, dir);
}

function dependsOnContent(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) => {
      const deps = pkg[field];
      return typeof deps === 'object' && deps !== null && '@analogjs/content' in deps;
    });
  } catch {
    return false;
  }
}

const posix = (path: string): string => path.split(sep).join('/');

/**
 * The pages of an Analog app, from its file router: `*.page.ts` files in `src/app/pages` (and the additional pages
 * directories), plus Markdown content routes. A layout and its index page resolve to the same URL once. Each route
 * carries its source file (`sourcePage`, relative to the project), which is the key of the page's lazily loaded chunk
 * in the Vite client manifest.
 */
export function discoverAnalogPages(options: AnalogPagesOptions): DiscoveredRoute[] {
  const root = resolve(options.root);
  const workspaceRoot = resolve(options.workspaceRoot ?? root).replace(/\\/g, '/');
  const sourceRoot = options.sourceRoot ?? 'src';
  const content = options.contentRoutes ?? dependsOnContent(root);
  const pageDirs = [
    join(root, sourceRoot, 'app', 'pages'),
    ...(options.additionalPagesDirs ?? []).map((dir) => resolveDir(dir, workspaceRoot)),
  ];
  const contentDirs = content
    ? [
        join(root, sourceRoot, 'app', 'pages'),
        join(root, sourceRoot, 'content'),
        ...(options.additionalContentDirs ?? []).map((dir) => resolveDir(dir, workspaceRoot)),
      ]
    : [];

  const files: Array<{ dir: string; file: string }> = [];
  for (const dir of pageDirs)
    for (const file of walk(dir, (name) => name.endsWith('.page.ts'))) files.push({ dir, file });
  for (const dir of contentDirs)
    for (const file of walk(dir, (name) => name.endsWith('.md'))) files.push({ dir, file });

  const routes = new Map<string, DiscoveredRoute>();
  for (const { dir, file } of files) {
    const pathname = analogRoutePath(relative(dir, file));
    // The first file wins: app pages come before shared libraries (Analog's collision priority).
    if (routes.has(pathname)) continue;
    const sourcePage = posix(relative(root, file));
    routes.set(pathname, { pathname, kind: 'page', sourcePage, frameworkId: sourcePage });
  }
  return [...routes.values()];
}

/**
 * Per-page client assets: the lazily loaded chunk of a route (and what it imports statically, with its CSS) is
 * preloaded for that page. Analog's router loads every route file with a dynamic `import()`, which Vite's manifest
 * lists as an entry keyed by the source file.
 */
export const analogPageAssets: PageAssets = (route, manifest, base) => {
  if (!route.sourcePage) return undefined;
  const keys = entriesForSources(manifest, [route.sourcePage]);
  if (!keys.length) return undefined;
  // The route chunk is loaded right after the entry, so it is a preload candidate for this page.
  return assetsForEntries(manifest, keys, base);
};

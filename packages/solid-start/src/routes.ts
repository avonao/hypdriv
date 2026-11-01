import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type DiscoveredRoute, normalizePathname } from '@hypdriv/vite';
import { SERVER_FUNCTIONS_PATH } from './constants';

/** The file extensions SolidStart's file router matches by default (`solidStart({ extensions })` adds more). */
export const DEFAULT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx'] as const;

/** The HTTP methods a route module can export a handler for (SolidStart's API routes). */
export const HTTP_METHODS = ['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Methods that make a file an API route (`OPTIONS` alone does not: the API router ignores it). */
const API_METHODS = new Set(['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Where SolidStart looks for routes: `solidStart({ appRoot, routeDir, extensions })`. */
export interface RouteLayout {
  /** Application source directory (`./src`). */
  appRoot?: string;
  /** Routes directory inside the app root (`./routes`). */
  routeDir?: string;
  /** Extensions besides `js`, `jsx`, `ts` and `tsx`. */
  extensions?: string[];
}

/** The routes directory and extensions the SolidStart plugin resolved in this process, when it exposes them. */
export function solidRouterLayout(): { dir: string; extensions: string[] } | null {
  const routers = (
    globalThis as { ROUTERS?: Record<string, { config?: { dir?: unknown; extensions?: unknown } }> }
  ).ROUTERS;
  const config = routers?.ssr?.config ?? routers?.client?.config;
  if (!config || typeof config.dir !== 'string' || !Array.isArray(config.extensions)) return null;
  return { dir: config.dir, extensions: config.extensions.filter((e): e is string => typeof e === 'string') };
}

/** The absolute routes directory and the matched extensions for a project. */
export function resolveLayout(root: string, layout: RouteLayout = {}): { dir: string; extensions: string[] } {
  const known = solidRouterLayout();
  const explicit = layout.appRoot !== undefined || layout.routeDir !== undefined;
  const extensions = [
    ...new Set([...DEFAULT_EXTENSIONS, ...(layout.extensions ?? []), ...(known?.extensions ?? [])]),
  ];
  if (known && !explicit) return { dir: known.dir, extensions };
  const dir = join(layout.appRoot ?? './src', layout.routeDir ?? './routes');
  return { dir: isAbsolute(dir) ? dir : resolve(root, dir), extensions };
}

/** The source with comments and the contents of strings and template literals blanked out (offsets are kept). */
export function stripNonCode(source: string): string {
  let out = '';
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      out += ch + blank(source.slice(i + 1, j)) + (j < source.length ? ch : '');
      i = j;
    } else if (ch === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      out += blank(source.slice(i, j));
      i = j - 1;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop - 1;
    } else out += ch;
  }
  return out;
}

/** What a route module exports: whether it has a default export and its named value exports. */
export interface ModuleExports {
  default: boolean;
  names: string[];
}

/**
 * The exports of a route module, read from its source without running it: `export default`, `export { x as default }`,
 * `export function|class|const|let|var NAME`, `export { a, b as c }` (type-only exports excluded). `export * from`
 * cannot be resolved here and is ignored.
 */
export function moduleExports(source: string): ModuleExports {
  const code = stripNonCode(source);
  const names = new Set<string>();
  let hasDefault = /\bexport\s+default\b/.test(code);
  for (const m of code.matchAll(
    /\bexport\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1] as string);
  for (const m of code.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))
    names.add(m[1] as string);
  for (const m of code.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var)\s*\{([^}]*)\}/g))
    for (const part of (m[1] as string).split(',')) {
      const name = part.split(':').at(-1)?.split('=')[0]?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  for (const m of code.matchAll(/\bexport\s*(type\s*)?\{([^}]*)\}/g)) {
    if (m[1]) continue;
    for (const part of (m[2] as string).split(',')) {
      const spec = part.trim();
      if (!spec || /^type\s/.test(spec)) continue;
      const exported = spec
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (!exported) continue;
      if (exported === 'default') hasDefault = true;
      else names.add(exported);
    }
  }
  return { default: hasDefault, names: [...names] };
}

/** A route file of the application as SolidStart's file router sees it. */
export interface SolidRouteFile {
  /** Absolute path. */
  file: string;
  /** The file relative to the project root (forward slashes). */
  sourcePage: string;
  /** SolidStart's route id, `(group)` folders included (`/(auth)/login`, `/blog/:slug`, `/docs/*rest`). */
  id: string;
  /** Renders a component (a default export, or a Markdown file). */
  page: boolean;
  /** HTTP methods the module exports handlers for. */
  methods: string[];
}

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
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
}

/**
 * The route id of a file, as SolidStart's file router derives it: the routes directory and extension stripped, a
 * trailing `index` segment dropped (`blog/index` → `/blog/`), `[id]` → `:id`, `[[id]]` → `:id?`, `[...rest]` → `*rest`.
 */
export function routeId(relativePath: string, extensions: readonly string[]): string {
  const stripped = relativePath
    .split(sep)
    .join('/')
    .replace(new RegExp(`\\.(?:${extensions.join('|')})$`), '')
    .replace(/(^|\/)index$/, '$1')
    .replace(/\[([^/]+)\]/g, (_, name: string) => {
      if (name.length > 3 && name.startsWith('...')) return `*${name.slice(3)}`;
      if (name.length > 2 && name.startsWith('[') && name.endsWith(']')) return `:${name.slice(1, -1)}?`;
      return `:${name}`;
    });
  return stripped.length > 0 ? `/${stripped}` : '/';
}

/** Scans the routes directory: every module with a default export or HTTP handlers (the others are not routes). */
export function scanRouteFiles(root: string, layout: RouteLayout = {}): SolidRouteFile[] {
  const { dir, extensions } = resolveLayout(root, layout);
  const files: string[] = [];
  walk(dir, files);
  const extension = new RegExp(`\\.(?:${extensions.join('|')})$`);
  const out: SolidRouteFile[] = [];
  for (const file of files) {
    if (!extension.test(file) || file.endsWith('.d.ts')) continue;
    const id = routeId(relative(dir, file), extensions);
    const sourcePage = relative(root, file).split(sep).join('/');
    if (/\.mdx?$/.test(file)) {
      out.push({ file, sourcePage, id, page: true, methods: [] });
      continue;
    }
    let source = '';
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const exports = moduleExports(source);
    const methods = HTTP_METHODS.filter((m) => exports.names.includes(m));
    if (!exports.default && !methods.length) continue;
    out.push({ file, sourcePage, id, page: exports.default, methods });
  }
  return out;
}

/**
 * A parameter name Hypdriv's route matcher accepts (it becomes a regular-expression group name): SolidStart allows
 * names such as `404` (`[...404].tsx`, the conventional not-found route), which are not identifiers.
 */
function paramName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(clean) ? clean : `_${clean}`;
}

/** Hypdriv's canonical pattern for a SolidStart route id: groups removed, `:id` → `[id]`, `:id?` → `[[id]]`, `*rest` → `[...rest]`. */
export function toPattern(id: string): string {
  const segments = id
    .replace(/\([^)/]+\)/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const optional = /^:([^?]+)\?$/.exec(segment);
      if (optional) return `[[${paramName(optional[1] as string)}]]`;
      if (segment.startsWith(':') && segment.length > 1) return `[${paramName(segment.slice(1))}]`;
      if (segment.startsWith('*')) return `[...${paramName(segment.slice(1) || 'rest')}]`;
      return segment;
    });
  return normalizePathname(segments.join('/'));
}

/** A route of the application as Hypdriv sees it. */
export interface SolidRoute {
  /** Hypdriv's canonical pattern (`/posts/[slug]`, `/docs/[...rest]`, `/[[lang]]/about`). */
  pathname: string;
  /** `page` renders a component; `endpoint` is an API route (only HTTP handlers). */
  kind: 'page' | 'endpoint';
  /** The route file, relative to the project root. */
  sourcePage: string;
  /** The route file's absolute path and its layouts' (the code-split chunks a page loads). */
  files: string[];
  /** SolidStart's route id. */
  frameworkId: string;
}

/**
 * Hypdriv routes from the route files, following SolidStart's route tree: a layout (a page module with pages below
 * it) is not a route of its own — its children are, and the child `index` answers the layout's path — pages and API
 * routes are separate routes, and a module with a default export and HTTP handlers is a page (the API router
 * answers first for the methods it exports, and falls through to the page when `GET` returns nothing).
 */
export function solidRoutes(files: SolidRouteFile[]): SolidRoute[] {
  const pages = files.filter((f) => f.page);
  const ancestors = (page: SolidRouteFile) =>
    pages.filter((p) => p !== page && page.id.startsWith(`${p.id}/`) && p.id !== '/');
  const out: SolidRoute[] = [];
  const seen = new Set<string>();
  const add = (route: SolidRoute) => {
    const key = `${route.kind}:${route.pathname}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(route);
  };
  for (const page of pages) {
    const isLayout = pages.some((p) => p !== page && p.id.startsWith(`${page.id}/`) && page.id !== '/');
    if (isLayout) continue;
    add({
      pathname: toPattern(page.id),
      kind: 'page',
      sourcePage: page.sourcePage,
      files: [page.file, ...ancestors(page).map((a) => a.file)],
      frameworkId: page.id,
    });
  }
  for (const file of files) {
    if (file.page || !file.methods.some((m) => API_METHODS.has(m))) continue;
    add({
      pathname: toPattern(file.id),
      kind: 'endpoint',
      sourcePage: file.sourcePage,
      files: [file.file],
      frameworkId: file.id,
    });
  }
  return out;
}

/** Whether a source file declares server functions (`"use server"` at the top of the module or of a function). */
const USE_SERVER = /(?:^|[\n;{])\s*['"]use server['"]/;

/** Whether the application has server functions: SolidStart then serves `/_server` for them. */
export function usesServerFunctions(root: string, appRoot = './src'): boolean {
  const dir = isAbsolute(appRoot) ? appRoot : resolve(root, appRoot);
  const files: string[] = [];
  walk(dir, files);
  for (const file of files) {
    if (!/\.(?:[jt]sx?|mdx?)$/.test(file) || file.endsWith('.d.ts')) continue;
    try {
      if (statSync(file).size > 2 * 1024 * 1024) continue;
      if (USE_SERVER.test(readFileSync(file, 'utf8'))) return true;
    } catch {
      // unreadable: not ours to judge
    }
  }
  return false;
}

/** The discovered routes Hypdriv's manifest is built from: the file routes, plus the server-function endpoint. */
export function toDiscoveredRoutes(
  routes: SolidRoute[],
  options: { serverFunctions?: boolean } = {},
): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = routes.map((route) => ({
    pathname: route.pathname,
    kind: route.kind,
    sourcePage: route.sourcePage,
    frameworkId: route.frameworkId,
  }));
  if (options.serverFunctions)
    out.push({
      pathname: `${SERVER_FUNCTIONS_PATH}/[[...path]]`,
      kind: 'endpoint',
      frameworkId: SERVER_FUNCTIONS_PATH,
    });
  return out;
}

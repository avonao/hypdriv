import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type DiscoveredRoute, normalizePathname } from '@hypdriv/vite';
import { parseAst } from 'vite';
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

/**
 * The source with comments, the contents of strings and template literals (`${…}` interpolations included) and
 * regular-expression literals blanked out (offsets and line breaks are kept). This is the fallback reader for
 * modules the parser rejects; it knows nothing about JSX text, where an apostrophe still looks like a quote.
 */
export function stripNonCode(source: string): string {
  const out: string[] = [];
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  // The previous significant character decides whether `/` starts a regular expression or divides.
  let previous = '';
  let previousWord = '';
  const regexAllowed = () =>
    previous === '' ||
    /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) ||
    /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(previousWord);

  /** Reads the string or template starting at `i` (its opening quote); returns the index after it. */
  const readQuoted = (i: number): number => {
    const quote = source[i] as string;
    let j = i + 1;
    while (j < source.length && source[j] !== quote) {
      if (source[j] === '\\') j += 2;
      else if (quote === '`' && source[j] === '$' && source[j + 1] === '{') j = readInterpolation(j + 1);
      else j++;
    }
    return Math.min(j + 1, source.length);
  };
  /** Skips a `${ … }` interpolation starting at its `{`; templates inside it nest. */
  const readInterpolation = (open: number): number => {
    let depth = 0;
    let j = open;
    while (j < source.length) {
      const c = source[j] as string;
      if (c === '"' || c === "'" || c === '`') j = readQuoted(j);
      else {
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return j + 1;
        j++;
      }
    }
    return j;
  };

  for (let i = 0; i < source.length; ) {
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = readQuoted(i);
      const closed = source[end - 1] === ch && end - 1 > i;
      out.push(ch, blank(source.slice(i + 1, closed ? end - 1 : end)), closed ? ch : '');
      i = end;
      previous = ch;
      previousWord = '';
    } else if (ch === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      out.push(blank(source.slice(i, j)));
      i = j;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out.push(blank(source.slice(i, stop)));
      i = stop;
    } else if (ch === '/' && regexAllowed()) {
      // A regular expression literal: to the closing `/` on this line, `[...]` classes may hold one.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      if (source[j] === '/') {
        j++;
        while (j < source.length && /[a-z]/i.test(source[j] as string)) j++;
        out.push('/', blank(source.slice(i + 1, j)));
        i = j;
        previous = '/';
        previousWord = '';
      } else {
        out.push(ch);
        i++;
      }
    } else {
      out.push(ch);
      i++;
      if (/\s/.test(ch)) continue;
      if (/[\w$]/.test(ch)) {
        previousWord = /[\w$]/.test(source[i - 2] ?? ' ') ? previousWord + ch : ch;
        previous = ch;
      } else {
        previous = ch;
        previousWord = '';
      }
    }
  }
  return out.join('');
}

/** What a route module exports: whether it has a default export and its named value exports. */
export interface ModuleExports {
  default: boolean;
  names: string[];
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

/** The names a binding pattern declares (`a`, `{ a, b: c, ...d }`, `[a, ...b]`, `a = 1`). */
function patternNames(node: unknown, out: string[]): void {
  const n = node as AstNode | null;
  if (!n || typeof n !== 'object') return;
  switch (n.type) {
    case 'Identifier':
      out.push(n.name as string);
      break;
    case 'ObjectPattern':
      for (const property of n.properties as AstNode[])
        patternNames(property.type === 'RestElement' ? property.argument : property.value, out);
      break;
    case 'ArrayPattern':
      for (const element of n.elements as unknown[]) patternNames(element, out);
      break;
    case 'AssignmentPattern':
      patternNames(n.left, out);
      break;
    case 'RestElement':
      patternNames(n.argument, out);
      break;
  }
}

/** The language the parser reads a route file as; `null` for extensions it has no mode for. */
function parserLanguage(file: string | undefined): 'js' | 'jsx' | 'ts' | 'tsx' | null {
  const ext = /\.([cm]?[jt]sx?)$/.exec(file ?? '')?.[1];
  if (!ext) return null;
  if (ext.endsWith('tsx')) return 'tsx';
  if (ext.endsWith('ts')) return 'ts';
  return 'jsx';
}

/** Reads the exports from a parsed module; `null` when the parser rejects the source. */
function parsedExports(source: string, file: string | undefined): ModuleExports | null {
  const language = parserLanguage(file);
  // A route file in an extension the parser has no mode for (`solidStart({ extensions: ['md'] })`) is read as TSX
  // first, then as plain TypeScript (a `<T>value` cast is not valid TSX).
  for (const lang of language ? [language] : (['tsx', 'ts'] as const)) {
    let body: AstNode[];
    try {
      body = (parseAst(source, { lang }) as unknown as { body: AstNode[] }).body;
    } catch {
      continue;
    }
    const names = new Set<string>();
    let hasDefault = false;
    for (const node of body) {
      if (node.type === 'ExportDefaultDeclaration') hasDefault = true;
      if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
      const declaration = node.declaration as AstNode | null;
      if (declaration) {
        // Types, interfaces and `declare`d functions leave nothing behind at run time.
        if (declaration.type === 'VariableDeclaration') {
          if (declaration.declare === true) continue;
          const declared: string[] = [];
          for (const declarator of declaration.declarations as AstNode[])
            patternNames(declarator.id, declared);
          for (const name of declared) names.add(name);
        } else if (
          (declaration.type === 'FunctionDeclaration' ||
            declaration.type === 'ClassDeclaration' ||
            declaration.type === 'TSEnumDeclaration') &&
          declaration.declare !== true
        ) {
          const id = declaration.id as AstNode | null;
          if (id?.type === 'Identifier') names.add(id.name as string);
        }
      }
      for (const specifier of (node.specifiers as AstNode[] | undefined) ?? []) {
        if (specifier.exportKind === 'type') continue;
        const exported = specifier.exported as AstNode;
        const name = (exported.type === 'Identifier' ? exported.name : exported.value) as string;
        if (name === 'default') hasDefault = true;
        else names.add(name);
      }
    }
    return { default: hasDefault, names: [...names] };
  }
  return null;
}

/**
 * The exports of a route module, read from its source without running it: `export default`, `export { x as default }`,
 * `export function|class|const|let|var NAME` (destructuring included), `export { a, b as c }` (type-only exports
 * excluded). `export * from` cannot be resolved here and is ignored. The source is parsed (TypeScript and JSX
 * included, so quotes in JSX text and regular expressions cannot hide an export); a module the parser rejects
 * falls back to a lexical read of the source (`stripNonCode`). `file` picks the language by extension.
 */
export function moduleExports(source: string, file?: string): ModuleExports {
  const parsed = parsedExports(source, file);
  if (parsed) return parsed;
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
    const exports = moduleExports(source, file);
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

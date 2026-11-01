import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DiscoveredRoute } from '@hypdriv/vite';
import { parseAst } from 'vite';
import { rwsdkPattern } from './routes';

/**
 * Build-time route discovery. RedwoodSDK has no route files: the routes are the `route()`, `index()`, `prefix()`,
 * `layout()` and `render()` calls inside `defineApp([...])`, so the build reads them from the Worker entry's source
 * — the array literals, the route arrays it imports from other files (relative imports and `tsconfig` paths) and
 * the `const`s it names. What the build cannot read (a path computed at run time, a function that builds routes)
 * is reported and can be added with the plugin's `routes` option; the Worker itself reads the exact routes from
 * the running app (`appRoutes()`), so the pipeline never depends on this scan.
 */

type Ast = { type: string } & { [key: string]: unknown };

const isAst = (value: unknown): value is Ast =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
const child = (node: Ast, key: string): Ast | null => {
  const value = node[key];
  return isAst(value) ? value : null;
};
const list = (node: Ast, key: string): Array<Ast | null> => {
  const value = node[key];
  return Array.isArray(value) ? (value as Array<Ast | null>) : [];
};
const text = (node: Ast, key: string): string | undefined => {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
};

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs'];
const ROUTER_FUNCTIONS = new Set(['route', 'index', 'prefix', 'layout', 'render', 'except', 'defineApp']);

/** A route found in the source: RedwoodSDK's path, what renders it, and the file that declares it. */
export interface ScannedRoute {
  path: string;
  kind: 'page' | 'endpoint';
  file: string;
}

export interface ScanResult {
  routes: ScannedRoute[];
  /** Whether the Worker entry imports `withHypDriv` from `@hypdriv/rwsdk/worker`. */
  wrapped: boolean;
  /** Whether `hypdrivMiddleware()` is among the routes the scan read. */
  middleware: boolean;
  /** What the scan could not read: shown by the build, covered by the plugin's `routes` option. */
  warnings: string[];
  /** Every source file the scan read (the manifest depends on them). */
  files: string[];
}

interface ModuleInfo {
  file: string;
  body: Ast[];
  imports: Map<string, { source: string; imported: string }>;
  declarations: Map<string, Ast>;
  exports: Map<string, { local: string } | { node: Ast } | { source: string; imported: string }>;
  defaultExport: Ast | null;
}

type Resolved = { mod: ModuleInfo; node: Ast } | { external: string } | null;

/** JSON with comments and trailing commas (`tsconfig.json`, `wrangler.jsonc`). */
export function parseJsonc(source: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') out += source[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** `compilerOptions.paths` of the project's tsconfig, as prefix → directories (`@/` → `[<root>/src/]`). */
function readAliases(root: string): Array<{ prefix: string; targets: string[]; exact: boolean }> {
  const file = join(root, 'tsconfig.json');
  if (!existsSync(file)) return [];
  try {
    const options = (parseJsonc(readFileSync(file, 'utf8')) as { compilerOptions?: Record<string, unknown> })
      .compilerOptions;
    const paths = options?.paths as Record<string, string[]> | undefined;
    if (!paths) return [];
    const base = resolve(root, (options?.baseUrl as string | undefined) ?? '.');
    return Object.entries(paths).map(([pattern, targets]) => {
      const star = pattern.endsWith('*');
      return {
        prefix: star ? pattern.slice(0, -1) : pattern,
        exact: !star,
        targets: targets.map((t) => resolve(base, star ? t.replace(/\*$/, '') : t)),
      };
    });
  } catch {
    return [];
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Resolves a module specifier to a source file, or null for packages and anything not found. */
function resolveFile(base: string): string | null {
  if (isFile(base)) return base;
  const stripped = base.replace(/\.(?:m?js|jsx)$/, '');
  for (const stem of stripped === base ? [base] : [stripped, base]) {
    for (const extension of EXTENSIONS) if (isFile(`${stem}${extension}`)) return `${stem}${extension}`;
  }
  for (const extension of EXTENSIONS)
    if (isFile(join(base, `index${extension}`))) return join(base, `index${extension}`);
  return null;
}

const WORKER_MODULE = '@hypdriv/rwsdk/worker';

class Scanner {
  middleware = false;
  /** Declarations being read right now: a route array that spreads itself must not be followed forever. */
  readonly active = new Set<Ast>();
  readonly warnings: string[] = [];
  readonly files = new Set<string>();
  private readonly modules = new Map<string, ModuleInfo | null>();
  private readonly aliases: ReturnType<typeof readAliases>;

  constructor(readonly root: string) {
    this.aliases = readAliases(root);
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  rel(file: string): string {
    return relative(this.root, file).split('\\').join('/');
  }

  resolveSpecifier(specifier: string, from: string): string | null {
    if (specifier.startsWith('.')) return resolveFile(resolve(dirname(from), specifier));
    if (isAbsolute(specifier)) return null;
    for (const alias of this.aliases) {
      if (alias.exact ? specifier !== alias.prefix : !specifier.startsWith(alias.prefix)) continue;
      const rest = alias.exact ? '' : specifier.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const found = resolveFile(alias.exact ? target : join(target, rest));
        if (found) return found;
      }
    }
    return null;
  }

  load(file: string): ModuleInfo | null {
    if (this.modules.has(file)) return this.modules.get(file) ?? null;
    this.modules.set(file, null);
    let info: ModuleInfo | null = null;
    try {
      const source = readFileSync(file, 'utf8');
      const lang = file.endsWith('.tsx')
        ? 'tsx'
        : file.endsWith('.jsx')
          ? 'jsx'
          : /\.[cm]?ts$/.test(file)
            ? 'ts'
            : 'js';
      const program = parseAst(source, { lang }) as unknown as Ast;
      info = this.index(
        file,
        list(program, 'body').filter((n): n is Ast => n !== null),
      );
      this.files.add(file);
    } catch (error) {
      this.warn(`could not read ${this.rel(file)} (${(error as Error).message})`);
    }
    this.modules.set(file, info);
    return info;
  }

  private index(file: string, body: Ast[]): ModuleInfo {
    const info: ModuleInfo = {
      file,
      body,
      imports: new Map(),
      declarations: new Map(),
      exports: new Map(),
      defaultExport: null,
    };
    const declare = (declaration: Ast, exported: boolean): void => {
      if (declaration.type === 'VariableDeclaration') {
        for (const item of list(declaration, 'declarations')) {
          const id = item && child(item, 'id');
          const init = item && child(item, 'init');
          if (id?.type !== 'Identifier' || !init) continue;
          const name = text(id, 'name') as string;
          info.declarations.set(name, init);
          if (exported) info.exports.set(name, { local: name });
        }
      } else if (declaration.type === 'FunctionDeclaration') {
        const name = text(child(declaration, 'id') ?? ({} as Ast), 'name');
        if (!name) return;
        info.declarations.set(name, declaration);
        if (exported) info.exports.set(name, { local: name });
      }
    };
    for (const node of body) {
      if (node.type === 'ImportDeclaration') {
        if (text(node, 'importKind') === 'type') continue;
        const source = String((child(node, 'source') as Ast).value);
        for (const specifier of list(node, 'specifiers')) {
          if (!specifier) continue;
          const local = text(child(specifier, 'local') as Ast, 'name') as string;
          if (specifier.type === 'ImportDefaultSpecifier')
            info.imports.set(local, { source, imported: 'default' });
          else if (specifier.type === 'ImportNamespaceSpecifier')
            info.imports.set(local, { source, imported: '*' });
          else {
            const imported = child(specifier, 'imported');
            info.imports.set(local, {
              source,
              imported: String(imported?.type === 'Identifier' ? imported.name : imported?.value),
            });
          }
        }
      } else if (node.type === 'VariableDeclaration' || node.type === 'FunctionDeclaration') {
        declare(node, false);
      } else if (node.type === 'ExportNamedDeclaration') {
        const declaration = child(node, 'declaration');
        if (declaration) declare(declaration, true);
        const source = child(node, 'source');
        for (const specifier of list(node, 'specifiers')) {
          if (!specifier) continue;
          const local = child(specifier, 'local');
          const exported = child(specifier, 'exported');
          const localName = String(local?.type === 'Identifier' ? local.name : local?.value);
          const exportedName = String(exported?.type === 'Identifier' ? exported.name : exported?.value);
          info.exports.set(
            exportedName,
            source ? { source: String(source.value), imported: localName } : { local: localName },
          );
        }
      } else if (node.type === 'ExportDefaultDeclaration') {
        const declaration = child(node, 'declaration');
        if (declaration) info.defaultExport = declaration;
      }
    }
    return info;
  }

  /** What a name refers to in a module: a declaration (here or in an imported module) or an external package. */
  resolveName(name: string, mod: ModuleInfo, depth = 0): Resolved {
    if (depth > 24) return null;
    const declaration = mod.declarations.get(name);
    if (declaration) return { mod, node: declaration };
    const imported = mod.imports.get(name);
    if (!imported) return null;
    const file = this.resolveSpecifier(imported.source, mod.file);
    if (!file) return { external: imported.source };
    const target = this.load(file);
    if (!target) return null;
    return this.resolveExport(target, imported.imported, depth + 1);
  }

  resolveExport(mod: ModuleInfo, name: string, depth: number): Resolved {
    if (depth > 24) return null;
    if (name === 'default') {
      const node = mod.defaultExport;
      if (!node) return null;
      if (node.type === 'Identifier') return this.resolveName(text(node, 'name') as string, mod, depth + 1);
      return { mod, node };
    }
    const target = mod.exports.get(name);
    if (!target) return null;
    if ('local' in target) return this.resolveName(target.local, mod, depth + 1);
    if ('node' in target) return { mod, node: target.node };
    const file = this.resolveSpecifier(target.source, mod.file);
    if (!file) return { external: target.source };
    const next = this.load(file);
    return next ? this.resolveExport(next, target.imported, depth + 1) : null;
  }

  /** What `namespace.name` refers to when `namespace` is a `import * as namespace from '…'`. */
  resolveMember(node: Ast, mod: ModuleInfo): Resolved {
    const object = child(node, 'object');
    const property = child(node, 'property');
    if (node.computed || object?.type !== 'Identifier' || property?.type !== 'Identifier') return null;
    const imported = mod.imports.get(text(object, 'name') as string);
    if (imported?.imported !== '*') return null;
    const file = this.resolveSpecifier(imported.source, mod.file);
    if (!file) return { external: imported.source };
    const target = this.load(file);
    return target ? this.resolveExport(target, text(property, 'name') as string, 1) : null;
  }

  /** The RedwoodSDK router function a callee names (`route`, `prefix`, …), following renamed and namespace imports. */
  routerFunction(callee: Ast, mod: ModuleInfo): string | null {
    if (callee.type === 'Identifier') {
      const imported = mod.imports.get(text(callee, 'name') as string);
      return imported?.source.startsWith('rwsdk/') && ROUTER_FUNCTIONS.has(imported.imported)
        ? imported.imported
        : null;
    }
    if (callee.type === 'MemberExpression') {
      const object = child(callee, 'object');
      const property = child(callee, 'property');
      if (object?.type !== 'Identifier' || property?.type !== 'Identifier') return null;
      const imported = mod.imports.get(text(object, 'name') as string);
      const name = text(property, 'name') as string;
      return imported?.imported === '*' && imported.source.startsWith('rwsdk/') && ROUTER_FUNCTIONS.has(name)
        ? name
        : null;
    }
    return null;
  }
}

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
  'ChainExpression',
]);

function unwrap(node: Ast): Ast {
  let current = node;
  while (WRAPPERS.has(current.type)) {
    const inner = child(current, 'expression');
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** The string a path argument holds, or null for a computed path. */
function literalPath(node: Ast | null): string | null {
  if (!node) return null;
  const value = unwrap(node);
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'TemplateLiteral' && list(value, 'expressions').length === 0) {
    const quasi = list(value, 'quasis')[0];
    const cooked = (quasi?.value as { cooked?: string | null } | undefined)?.cooked;
    return typeof cooked === 'string' ? cooked : null;
  }
  return null;
}

/** Whether a function (or any expression) contains JSX: the signal RedwoodSDK's own router uses for a page. */
function containsJsx(root: Ast): boolean {
  let visited = 0;
  const walk = (value: unknown): boolean => {
    if (++visited > 20_000) return false;
    if (Array.isArray(value)) return value.some(walk);
    if (!isAst(value)) return false;
    if (value.type === 'JSXElement' || value.type === 'JSXFragment') return true;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (typeof entry === 'object' && entry !== null && walk(entry)) return true;
    }
    return false;
  };
  return walk(root);
}

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

interface Found {
  path: string;
  kind: 'page' | 'endpoint';
  file: string;
}

function evaluate(scanner: Scanner, node: Ast, mod: ModuleInfo, depth: number): Found[] {
  if (depth > 48) {
    scanner.warn(`route arrays nest too deeply to read (${scanner.rel(mod.file)})`);
    return [];
  }
  const value = unwrap(node);
  switch (value.type) {
    case 'ArrayExpression':
      return list(value, 'elements').flatMap((element) =>
        element ? evaluate(scanner, element, mod, depth + 1) : [],
      );
    case 'SpreadElement': {
      const argument = child(value, 'argument');
      return argument ? evaluate(scanner, argument, mod, depth + 1) : [];
    }
    case 'ConditionalExpression':
      return ['consequent', 'alternate'].flatMap((key) => {
        const branch = child(value, key);
        return branch ? evaluate(scanner, branch, mod, depth + 1) : [];
      });
    case 'LogicalExpression': {
      const right = child(value, 'right');
      return right ? evaluate(scanner, right, mod, depth + 1) : [];
    }
    case 'Identifier': {
      const resolved = scanner.resolveName(text(value, 'name') as string, mod);
      if (!resolved) {
        scanner.warn(`could not resolve \`${text(value, 'name')}\` in ${scanner.rel(mod.file)}`);
        return [];
      }
      // A package's export in a route array is middleware (an array of routes would come from your own code).
      if ('external' in resolved) return [];
      if (FUNCTIONS.has(resolved.node.type)) return []; // middleware
      if (scanner.active.has(resolved.node)) return [];
      scanner.active.add(resolved.node);
      try {
        return evaluate(scanner, resolved.node, resolved.mod, depth + 1);
      } finally {
        scanner.active.delete(resolved.node);
      }
    }
    case 'MemberExpression': {
      // `routes.admin` of a namespace import, or middleware such as `auth.requireUser`.
      const resolved = scanner.resolveMember(value, mod);
      if (!resolved || 'external' in resolved || FUNCTIONS.has(resolved.node.type)) return [];
      if (scanner.active.has(resolved.node)) return [];
      scanner.active.add(resolved.node);
      try {
        return evaluate(scanner, resolved.node, resolved.mod, depth + 1);
      } finally {
        scanner.active.delete(resolved.node);
      }
    }
    case 'CallExpression':
      return evaluateCall(scanner, value, mod, depth);
    default:
      return [];
  }
}

function evaluateCall(scanner: Scanner, call: Ast, mod: ModuleInfo, depth: number): Found[] {
  const callee = child(call, 'callee');
  const args = list(call, 'arguments');
  if (!callee) return [];
  const fn = scanner.routerFunction(callee, mod);
  const arg = (index: number): Ast | null => args[index] ?? null;
  switch (fn) {
    case 'route': {
      const path = literalPath(arg(0));
      if (path === null) {
        scanner.warn(
          `a route path in ${scanner.rel(mod.file)} is computed, so the build cannot read it: add the route with the plugin's \`routes\` option`,
        );
        return [];
      }
      return [{ path, kind: handlerKind(scanner, arg(1), mod, 0), file: mod.file }];
    }
    case 'index':
      return [{ path: '/', kind: handlerKind(scanner, arg(0), mod, 0), file: mod.file }];
    case 'prefix': {
      const prefix = literalPath(arg(0));
      const routes = arg(1);
      if (prefix === null) {
        scanner.warn(
          `a prefix in ${scanner.rel(mod.file)} is computed, so the build cannot read its routes: add them with the plugin's \`routes\` option`,
        );
        return [];
      }
      return routes
        ? evaluate(scanner, routes, mod, depth + 1).map((found) => ({
            ...found,
            path: `${prefix.startsWith('/') ? prefix : `/${prefix}`}/${found.path}`.replace(/\/+/g, '/'),
          }))
        : [];
    }
    case 'layout':
    case 'render': {
      const routes = arg(1);
      return routes ? evaluate(scanner, routes, mod, depth + 1) : [];
    }
    case 'except':
      return [];
    case 'defineApp': {
      const routes = arg(0);
      return routes ? evaluate(scanner, routes, mod, depth + 1) : [];
    }
    default:
      break;
  }
  // A call of your own function: a middleware factory (`requireAuth()`) or a function that returns routes.
  if (callee.type === 'Identifier') {
    const imported = mod.imports.get(text(callee, 'name') as string);
    if (imported?.source === WORKER_MODULE && imported.imported === 'hypdrivMiddleware') {
      scanner.middleware = true;
      return [];
    }
    const resolved = scanner.resolveName(text(callee, 'name') as string, mod);
    if (resolved && !('external' in resolved) && FUNCTIONS.has(resolved.node.type)) {
      const body = child(resolved.node, 'body');
      const expression =
        body && body.type !== 'BlockStatement' ? body : body ? returnedExpression(body) : null;
      if (expression && !FUNCTIONS.has(unwrap(expression).type))
        return evaluate(scanner, expression, resolved.mod, depth + 1);
    }
  }
  return [];
}

/** The expression of a block's `return`, for functions that build route arrays. */
function returnedExpression(block: Ast): Ast | null {
  for (const statement of list(block, 'body')) {
    if (statement?.type === 'ReturnStatement') return child(statement, 'argument');
  }
  return null;
}

/** `page` when the handler renders JSX, `endpoint` when it returns a `Response` (RedwoodSDK's own distinction). */
function handlerKind(
  scanner: Scanner,
  node: Ast | null,
  mod: ModuleInfo,
  depth: number,
): 'page' | 'endpoint' {
  if (!node || depth > 12) return 'endpoint';
  const value = unwrap(node);
  switch (value.type) {
    case 'ArrayExpression': {
      const last = list(value, 'elements')
        .filter((e): e is Ast => e !== null && e.type !== 'SpreadElement')
        .at(-1);
      return handlerKind(scanner, last ?? null, mod, depth + 1);
    }
    case 'ObjectExpression': {
      for (const property of list(value, 'properties')) {
        if (property?.type !== 'Property') continue;
        const key = child(property, 'key');
        const name = key?.type === 'Identifier' ? key.name : key?.value;
        if (name === 'get') return handlerKind(scanner, child(property, 'value'), mod, depth + 1);
      }
      return 'endpoint';
    }
    case 'Identifier': {
      const name = text(value, 'name') as string;
      const resolved = scanner.resolveName(name, mod);
      if (resolved && !('external' in resolved)) {
        if (containsJsx(resolved.node)) return 'page';
        return FUNCTIONS.has(resolved.node.type) || resolved.node.type === 'CallExpression'
          ? 'endpoint'
          : handlerKind(scanner, resolved.node, resolved.mod, depth + 1);
      }
      // Not readable (a client component from a package, a missing file): components are PascalCase by convention.
      return /^[A-Z]/.test(name) ? 'page' : 'endpoint';
    }
    default:
      return containsJsx(value) ? 'page' : 'endpoint';
  }
}

/** The routes `defineApp` receives, found from the Worker entry's default export. */
function appRoutesOf(scanner: Scanner, node: Ast, mod: ModuleInfo, depth: number): Found[] | null {
  if (depth > 12) return null;
  const value = unwrap(node);
  if (value.type === 'CallExpression') {
    const callee = child(value, 'callee');
    if (callee && scanner.routerFunction(callee, mod) === 'defineApp') {
      const routes = list(value, 'arguments')[0];
      return routes ? evaluate(scanner, routes, mod, 0) : [];
    }
    // `withHypDriv(defineApp([...]))`, `compose(defineApp(...))`: the app is one of the arguments.
    for (const argument of list(value, 'arguments')) {
      const found = argument ? appRoutesOf(scanner, argument, mod, depth + 1) : null;
      if (found) return found;
    }
    return null;
  }
  if (value.type === 'Identifier') {
    const resolved = scanner.resolveName(text(value, 'name') as string, mod);
    return resolved && !('external' in resolved)
      ? appRoutesOf(scanner, resolved.node, resolved.mod, depth + 1)
      : null;
  }
  if (value.type === 'ObjectExpression') {
    for (const property of list(value, 'properties')) {
      const argument = property?.type === 'SpreadElement' ? child(property, 'argument') : null;
      const found = argument ? appRoutesOf(scanner, argument, mod, depth + 1) : null;
      if (found) return found;
    }
  }
  return null;
}

/**
 * Reads the routes of a RedwoodSDK app from its Worker entry (`src/worker.tsx`): `export default defineApp([...])`,
 * `export default withHypDriv(defineApp([...]))`, or a default export that names a `const app = defineApp(...)`.
 */
export function scanWorkerRoutes(root: string, entry: string): ScanResult {
  const scanner = new Scanner(root);
  const routes: ScannedRoute[] = [];
  const mod = existsSync(entry) ? scanner.load(entry) : null;
  if (!mod) {
    scanner.warn(`the Worker entry ${scanner.rel(entry)} does not exist`);
  } else if (!mod.defaultExport) {
    scanner.warn(`${scanner.rel(entry)} has no default export (the \`defineApp([...])\` app)`);
  } else {
    const found = appRoutesOf(scanner, mod.defaultExport, mod, 0);
    if (!found)
      scanner.warn(`no \`defineApp([...])\` call found in the default export of ${scanner.rel(entry)}`);
    else routes.push(...found);
  }
  const wrapped = [...(mod?.imports.values() ?? [])].some(
    (i) => i.source === WORKER_MODULE && i.imported === 'withHypDriv',
  );
  return {
    routes,
    wrapped,
    middleware: scanner.middleware,
    warnings: scanner.warnings,
    files: [...scanner.files],
  };
}

/** The scan's routes in the shape the manifest builder takes. */
export function discoveredRoutes(root: string, scanned: readonly ScannedRoute[]): DiscoveredRoute[] {
  const seen = new Map<string, DiscoveredRoute>();
  for (const route of scanned) {
    const pathname = rwsdkPattern(route.path);
    const key = `${route.kind}:${pathname}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      pathname,
      kind: route.kind,
      sourcePage: relative(root, route.file).split('\\').join('/'),
    });
  }
  return [...seen.values()];
}

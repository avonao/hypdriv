import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSIONS,
  moduleExports,
  resolveLayout,
  routeId,
  scanRouteFiles,
  solidRoutes,
  stripNonCode,
  toDiscoveredRoutes,
  toPattern,
  usesServerFunctions,
} from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { ROUTERS?: unknown }).ROUTERS;
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-solid-routes-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const PAGE = 'export default function Page() { return null; }\n';

describe('stripNonCode', () => {
  it('blanks comments and string contents but keeps offsets and line breaks', () => {
    const source = `const a = "export default";\n// export const GET\n/* export function POST */ let b = \`export { x }\`;`;
    const code = stripNonCode(source);
    expect(code).toHaveLength(source.length);
    expect(code).not.toMatch(/export/);
    expect(code.split('\n')).toHaveLength(3);
    expect(code).toContain('const a = "');
    expect(code).toContain('let b = `');
  });

  it('handles escaped quotes and unterminated input', () => {
    expect(stripNonCode(String.raw`x = "a\"export"; y`)).not.toMatch(/export/);
    expect(stripNonCode('/* never closed export default')).not.toMatch(/export/);
    expect(stripNonCode('"never closed export')).not.toMatch(/export/);
  });
});

describe('moduleExports', () => {
  it('reads the default export and the named value exports', () => {
    expect(moduleExports('export default function Home() {}')).toEqual({ default: true, names: [] });
    expect(
      moduleExports(
        'export async function GET() {}\nexport const POST = () => {};\nexport let PUT = 1, x;\nexport class Thing {}',
      ),
    ).toEqual({ default: false, names: ['GET', 'POST', 'PUT', 'Thing'] });
    expect(moduleExports('export function* gen() {}').names).toEqual(['gen']);
  });

  it('reads export lists, renames and default re-exports', () => {
    const exports = moduleExports('const a = 1, b = 2;\nexport { a, b as DELETE, c as default };');
    expect(exports.default).toBe(true);
    expect(exports.names).toEqual(['a', 'DELETE']);
  });

  it('reads destructured exports', () => {
    expect(moduleExports('export const { GET, post: POST, x = 1 } = handlers;').names).toEqual([
      'GET',
      'POST',
      'x',
    ]);
  });

  it('ignores type-only exports, strings and comments', () => {
    const source = [
      'export type { Foo };',
      'export { type Bar, baz };',
      'export type Alias = string;',
      '// export default nothing',
      '/* export const GET = 1 */',
      'const s = "export default";',
    ].join('\n');
    expect(moduleExports(source)).toEqual({ default: false, names: ['baz'] });
  });

  it('does not see `export * from` (it cannot be resolved without running the module)', () => {
    expect(moduleExports("export * from './handlers';")).toEqual({ default: false, names: [] });
  });
});

describe('routeId', () => {
  const id = (path: string) => routeId(path.split('/').join('/'), DEFAULT_EXTENSIONS);

  it('derives SolidStart route ids from file paths', () => {
    expect(id('index.tsx')).toBe('/');
    expect(id('about.tsx')).toBe('/about');
    expect(id('blog/index.tsx')).toBe('/blog/');
    expect(id('blog/hello-world.jsx')).toBe('/blog/hello-world');
    expect(id('posts/[slug].tsx')).toBe('/posts/:slug');
    expect(id('[[lang]]/about.tsx')).toBe('/:lang?/about');
    expect(id('docs/[...rest].tsx')).toBe('/docs/*rest');
    expect(id('(auth)/login.tsx')).toBe('/(auth)/login');
    expect(id('api/time.ts')).toBe('/api/time');
    expect(id('api/jobs/[job].ts')).toBe('/api/jobs/:job');
  });

  it('honours extra extensions', () => {
    expect(routeId('guide.mdx', [...DEFAULT_EXTENSIONS, 'mdx'])).toBe('/guide');
    expect(routeId('guide.mdx', DEFAULT_EXTENSIONS)).toBe('/guide.mdx');
  });
});

describe('toPattern', () => {
  it('maps route ids to Hypdriv patterns', () => {
    expect(toPattern('/')).toBe('/');
    expect(toPattern('/about')).toBe('/about');
    expect(toPattern('/blog/')).toBe('/blog');
    expect(toPattern('/posts/:slug')).toBe('/posts/[slug]');
    expect(toPattern('/:lang?/about')).toBe('/[[lang]]/about');
    expect(toPattern('/docs/*rest')).toBe('/docs/[...rest]');
    expect(toPattern('/*')).toBe('/[...rest]');
  });

  it('removes route groups', () => {
    expect(toPattern('/(auth)/login')).toBe('/login');
    expect(toPattern('/(marketing)/(eu)/pricing')).toBe('/pricing');
    expect(toPattern('/(shop)/')).toBe('/');
  });

  it('keeps parameter names usable as regular-expression group names', () => {
    // `[...404].tsx` is SolidStart's conventional not-found route.
    expect(toPattern('/*404')).toBe('/[..._404]');
    expect(toPattern('/:2fa')).toBe('/[_2fa]');
    expect(toPattern('/:first-name')).toBe('/[first_name]');
  });
});

describe('resolveLayout', () => {
  it('defaults to ./src/routes and the default extensions', () => {
    const { dir, extensions } = resolveLayout('/app');
    expect(dir).toBe('/app/src/routes');
    expect(extensions).toEqual([...DEFAULT_EXTENSIONS]);
  });

  it('follows appRoot, routeDir and extra extensions', () => {
    const { dir, extensions } = resolveLayout('/app', {
      appRoot: './web',
      routeDir: './pages',
      extensions: ['mdx'],
    });
    expect(dir).toBe('/app/web/pages');
    expect(extensions).toContain('mdx');
  });

  it('uses the directory SolidStart resolved in this process unless the options say otherwise', () => {
    (globalThis as { ROUTERS?: unknown }).ROUTERS = {
      ssr: { config: { dir: '/app/custom/routes', extensions: ['tsx', 'md'] } },
    };
    const known = resolveLayout('/app');
    expect(known.dir).toBe('/app/custom/routes');
    expect(known.extensions).toContain('md');
    expect(resolveLayout('/app', { routeDir: './other' }).dir).toBe('/app/src/other');
  });
});

describe('scanRouteFiles and solidRoutes', () => {
  const root = () =>
    project({
      'src/routes/index.tsx': PAGE,
      'src/routes/about.tsx': PAGE,
      'src/routes/posts/index.tsx': PAGE,
      'src/routes/posts/[slug].tsx': PAGE,
      'src/routes/(auth)/login.tsx': PAGE,
      'src/routes/[...404].tsx': PAGE,
      'src/routes/[[lang]]/pricing.tsx': PAGE,
      'src/routes/api/time.ts': 'export function GET() { return Response.json({}); }\n',
      'src/routes/api/jobs/[job].ts': 'export const POST = () => new Response(null);\n',
      'src/routes/api/preflight.ts': 'export const OPTIONS = () => new Response(null);\n',
      'src/routes/helpers.ts': 'export const answer = 42;\n',
      'src/routes/types.d.ts': 'export default interface T {}\n',
      'src/routes/.hidden/secret.tsx': PAGE,
      'src/routes/reexport.tsx': 'function Page() { return null; }\nexport { Page as default };\n',
      'src/routes/guide.md': '# Guide\n',
      'src/routes/both.tsx': `${PAGE}export const GET = () => null;\n`,
    });

  it('keeps modules with a default export or HTTP handlers and nothing else', () => {
    const files = scanRouteFiles(root());
    const ids = files.map((f) => f.id).sort();
    expect(ids).toEqual(
      [
        '/',
        '/:lang?/pricing',
        '/(auth)/login',
        '/*404',
        '/about',
        '/api/jobs/:job',
        '/api/preflight',
        '/api/time',
        '/both',
        '/posts/',
        '/posts/:slug',
        '/reexport',
      ].sort(),
    );
    expect(files.find((f) => f.id === '/api/time')).toMatchObject({ page: false, methods: ['GET'] });
    expect(files.find((f) => f.id === '/api/jobs/:job')).toMatchObject({ page: false, methods: ['POST'] });
    expect(files.find((f) => f.id === '/both')).toMatchObject({ page: true, methods: ['GET'] });
    expect(files.find((f) => f.id === '/reexport')?.page).toBe(true);
    expect(files.find((f) => f.id === '/about')?.sourcePage).toBe('src/routes/about.tsx');
  });

  it('turns them into Hypdriv routes: groups removed, endpoints for handlers, OPTIONS alone is no route', () => {
    const routes = solidRoutes(scanRouteFiles(root()));
    const summary = routes.map((r) => `${r.kind} ${r.pathname}`).sort();
    expect(summary).toEqual(
      [
        'page /',
        'page /[..._404]',
        'page /[[lang]]/pricing',
        'page /about',
        'page /both',
        'page /login',
        'page /posts',
        'page /posts/[slug]',
        'page /reexport',
        'endpoint /api/jobs/[job]',
        'endpoint /api/time',
      ].sort(),
    );
    expect(routes.find((r) => r.pathname === '/login')?.frameworkId).toBe('/(auth)/login');
  });

  it('treats a page with child pages as a layout: only the children are routes, the index answers its path', () => {
    const layouts = project({
      'src/routes/blog.tsx': PAGE,
      'src/routes/blog/index.tsx': PAGE,
      'src/routes/blog/[id].tsx': PAGE,
      'src/routes/blog/archive.tsx': PAGE,
      'src/routes/index.tsx': PAGE,
    });
    const routes = solidRoutes(scanRouteFiles(layouts));
    expect(routes.map((r) => r.pathname).sort()).toEqual(['/', '/blog', '/blog/[id]', '/blog/archive']);
    const post = routes.find((r) => r.pathname === '/blog/[id]');
    // The layout's chunk loads with the child's.
    expect(post?.files.map((f) => f.slice(layouts.length + 1))).toEqual([
      'src/routes/blog/[id].tsx',
      'src/routes/blog.tsx',
    ]);
    const index = routes.find((r) => r.pathname === '/blog');
    expect(index?.files.map((f) => f.slice(layouts.length + 1))).toEqual([
      'src/routes/blog/index.tsx',
      'src/routes/blog.tsx',
    ]);
    // The root index is no layout.
    expect(routes.find((r) => r.pathname === '/')?.files).toHaveLength(1);
  });

  it('does not list a duplicate when a page and a group-prefixed page share a pattern', () => {
    const dupes = project({ 'src/routes/(a)/hello.tsx': PAGE, 'src/routes/(b)/hello.tsx': PAGE });
    expect(solidRoutes(scanRouteFiles(dupes)).map((r) => r.pathname)).toEqual(['/hello']);
  });

  it('scans a custom app root, route directory and Markdown routes', () => {
    const custom = project({ 'web/pages/home.tsx': PAGE, 'web/pages/notes.mdx': '# Notes\n' });
    const files = scanRouteFiles(custom, { appRoot: './web', routeDir: './pages', extensions: ['mdx'] });
    expect(files.map((f) => f.id).sort()).toEqual(['/home', '/notes']);
    expect(files.find((f) => f.id === '/notes')?.page).toBe(true);
  });

  it('returns nothing for a project without a routes directory', () => {
    expect(scanRouteFiles(project({ 'package.json': '{}' }))).toEqual([]);
  });
});

describe('server functions', () => {
  it('finds "use server" at the top of a module or inside a function', () => {
    expect(usesServerFunctions(project({ 'src/a.ts': `'use server';\nexport const x = 1;\n` }))).toBe(true);
    expect(
      usesServerFunctions(
        project({ 'src/routes/b.tsx': `export async function save() {\n  "use server";\n  return 1;\n}\n` }),
      ),
    ).toBe(true);
    expect(usesServerFunctions(project({ 'src/a.ts': 'export const x = 1;\n' }))).toBe(false);
    expect(usesServerFunctions(project({ 'src/a.ts': `const s = "not use server";\n` }))).toBe(false);
    expect(usesServerFunctions(project({ 'package.json': '{}' }))).toBe(false);
  });

  it('adds the /_server endpoint to the discovered routes', () => {
    const routes = solidRoutes(scanRouteFiles(project({ 'src/routes/index.tsx': PAGE })));
    expect(toDiscoveredRoutes(routes).map((r) => r.pathname)).toEqual(['/']);
    const withFunctions = toDiscoveredRoutes(routes, { serverFunctions: true });
    expect(withFunctions.at(-1)).toEqual({
      pathname: '/_server/[[...path]]',
      kind: 'endpoint',
      frameworkId: '/_server',
    });
  });
});

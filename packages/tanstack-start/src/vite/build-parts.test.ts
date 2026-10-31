import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StaticHeaderRule } from '@hypdriv/build';
import { afterEach, describe, expect, it } from 'vitest';
import { PRERENDER_HEADER } from '../constants';
import { clientChunksFrom, routeSources } from './assets';
import { documentsWithNonce, findDocuments } from './documents';
import {
  prerenderToken,
  resetStartRegistration,
  type StartOptionsLike,
  startRegistration,
  withHypDriv,
} from './options';
import { crawlStartRoutes, serverFnPattern, startRoutesFromNodes, toDiscoveredRoutes } from './routes';
import { nodeRouteRules, scrubPrerenderToken, targetForNitroPreset, writeVercelOverrides } from './targets';

const temp = () => mkdtempSync(join(tmpdir(), 'hypdriv-tss-'));
function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const route = (id: string, options = '{ component: () => null }') =>
  `import { createFileRoute } from '@tanstack/react-router'\nexport const Route = createFileRoute('${id}')(${options})\n`;
const server = `{ server: { handlers: { GET: () => new Response('x') } } }`;

afterEach(() => resetStartRegistration());

describe('route discovery', () => {
  const fixture = () => {
    const root = temp();
    write(root, {
      'package.json': '{"name":"fx","type":"module"}',
      'src/routes/__root.tsx':
        "import { createRootRoute } from '@tanstack/react-router'\nexport const Route = createRootRoute({})\n",
      'src/routes/index.tsx': route('/'),
      'src/routes/_auth.tsx': route('/_auth'),
      'src/routes/_auth/dashboard.tsx': route('/_auth/dashboard'),
      'src/routes/posts.tsx': route('/posts'),
      'src/routes/posts/index.tsx': route('/posts/'),
      'src/routes/posts/$postId.tsx': route('/posts/$postId'),
      'src/routes/posts_.$postId.edit.tsx': route('/posts_/$postId/edit'),
      'src/routes/(marketing)/pricing.tsx': route('/(marketing)/pricing'),
      'src/routes/files/$.tsx': route('/files/$'),
      'src/routes/{-$lang}/docs.tsx': route('/{-$lang}/docs'),
      'src/routes/sitemap[.]xml.ts': route('/sitemap.xml', server),
      'src/routes/api/users/$id.ts': route('/api/users/$id', server),
      'src/routes/hybrid.tsx': route(
        '/hybrid',
        `{ server: { handlers: { POST: () => new Response('x') } }, component: () => null }`,
      ),
      // Generator boilerplate the crawl would "fix": the file on disk must stay as written.
      'src/routes/about.tsx': route('/wrong-id'),
      'src/routes/-components/card.tsx': 'export const card = 1\n',
    });
    return root;
  };

  it('crawls with TanStack’s generator and maps routes to canonical patterns and kinds', async () => {
    const root = fixture();
    const routes = startRoutesFromNodes(await crawlStartRoutes(root), root);
    expect(routes.map((r) => `${r.kind} ${r.pathname}`)).toEqual([
      'page /',
      'page /[[lang]]/docs',
      'page /about',
      'endpoint /api/users/[id]',
      'page /dashboard',
      'page /files/[...splat]',
      'page /hybrid',
      'page /posts',
      'page /posts/[postId]',
      'page /posts/[postId]/edit',
      'page /pricing',
      'endpoint /sitemap.xml',
    ]);
    const posts = routes.find((r) => r.pathname === '/posts')!;
    // The layout and its index route are one page; the index is what the URL renders.
    expect(posts.frameworkId).toBe('/posts/');
    expect(posts.files.map((f) => f.slice(root.length))).toEqual(
      expect.arrayContaining(['/src/routes/posts/index.tsx', '/src/routes/posts.tsx']),
    );
    expect(routes.find((r) => r.pathname === '/dashboard')!.files.some((f) => f.endsWith('_auth.tsx'))).toBe(
      true,
    );
    expect(routes.find((r) => r.pathname === '/about')!.sourcePage).toBe('src/routes/about.tsx');
  });

  it('never writes to the project (route files, route tree)', async () => {
    const root = fixture();
    const about = join(root, 'src/routes/about.tsx');
    const before = { content: readFileSync(about, 'utf8'), mtime: statSync(about).mtimeMs };
    await crawlStartRoutes(root);
    expect(readFileSync(about, 'utf8')).toBe(before.content);
    expect(statSync(about).mtimeMs).toBe(before.mtime);
    expect(existsSync(join(root, 'src/routeTree.gen.ts'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['package.json', 'src']);
  });

  it("follows Start's srcDirectory and routesDirectory options", async () => {
    const root = temp();
    write(root, {
      'package.json': '{"name":"fx","type":"module"}',
      'app/pages/__root.tsx':
        "import { createRootRoute } from '@tanstack/react-router'\nexport const Route = createRootRoute({})\n",
      'app/pages/contact.tsx': route('/contact'),
    });
    const options = { srcDirectory: 'app', router: { routesDirectory: 'pages' } };
    const routes = startRoutesFromNodes(await crawlStartRoutes(root, options), root);
    expect(routes.map((r) => r.pathname)).toEqual(['/contact']);
  });

  it('adds the server-function endpoint under its configured base', () => {
    expect(serverFnPattern()).toBe('/_serverFn/[...id]');
    expect(serverFnPattern({ serverFns: { base: '/rpc' } })).toBe('/rpc/[...id]');
    const discovered = toDiscoveredRoutes([
      { pathname: '/a', kind: 'page', files: [], sourcePage: 'src/routes/a.tsx', frameworkId: '/a' },
    ]);
    expect(discovered).toEqual([
      { pathname: '/a', kind: 'page', sourcePage: 'src/routes/a.tsx', frameworkId: '/a' },
      { pathname: '/_serverFn/[...id]', kind: 'endpoint', frameworkId: 'server-functions' },
    ]);
  });
});

describe('withHypDriv', () => {
  it('marks every prerender request with the per-build token', () => {
    const options = withHypDriv({
      prerender: { enabled: true, headers: { 'x-app': '1' } },
      pages: [
        { path: '/' },
        { path: '/private', prerender: { enabled: true, headers: { authorization: 'Bearer build' } } },
      ],
      spa: { enabled: true },
    });
    const token = prerenderToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(options.prerender?.headers).toEqual({ 'x-app': '1', [PRERENDER_HEADER]: token });
    // Page-level headers replace Start's global ones: the token goes there too.
    expect(options.pages?.[1]?.prerender?.headers).toEqual({
      authorization: 'Bearer build',
      [PRERENDER_HEADER]: token,
    });
    expect(options.pages?.[0]).toEqual({ path: '/' });
    expect((options.spa as StartOptionsLike['spa'])?.prerender?.headers).toEqual({
      [PRERENDER_HEADER]: token,
    });
    expect(startRegistration()?.token).toBe(token);
  });

  it('writes prerendered pages as about.html unless the application chose otherwise', () => {
    expect(withHypDriv({}).prerender?.autoSubfolderIndex).toBe(false);
    expect(withHypDriv({ prerender: { autoSubfolderIndex: true } }).prerender?.autoSubfolderIndex).toBe(true);
    // No SPA object appears when the application has none (Start would enable SPA mode).
    expect('spa' in withHypDriv({})).toBe(false);
    expect(withHypDriv().prerender?.enabled).toBeUndefined();
  });

  it('keeps one token per build process and registers the application options', () => {
    const first = prerenderToken();
    const input = { srcDirectory: 'app' };
    withHypDriv(input);
    expect(prerenderToken()).toBe(first);
    expect(startRegistration()?.options).toBe(input);
  });
});

describe('client assets', () => {
  const bundle = {
    'assets/index.js': {
      type: 'chunk' as const,
      fileName: 'assets/index.js',
      isEntry: true,
      imports: ['assets/react.js'],
      moduleIds: ['/app/src/router.tsx', '/app/src/routes/about.tsx'],
      viteMetadata: { importedCss: new Set<string>(), importedAssets: new Set(['assets/app.css']) },
    },
    'assets/react.js': {
      type: 'chunk' as const,
      fileName: 'assets/react.js',
      imports: [],
      moduleIds: ['/app/node_modules/react/index.js'],
    },
    'assets/about.js': {
      type: 'chunk' as const,
      fileName: 'assets/about.js',
      isEntry: false,
      imports: ['assets/shared.js'],
      moduleIds: ['/app/src/routes/about.tsx?tsr-split=component'],
      viteMetadata: { importedCss: new Set(['assets/about.css']) },
    },
    'assets/shared.js': {
      type: 'chunk' as const,
      fileName: 'assets/shared.js',
      imports: [],
      moduleIds: ['/app/src/ui.tsx'],
    },
    'assets/lazy.js': {
      type: 'chunk' as const,
      fileName: 'assets/lazy.js',
      moduleIds: ['/app/src/routes/other.tsx?tsr-split=component'],
    },
    'assets/app.css': { type: 'asset' as const, fileName: 'assets/app.css' },
  };

  it("assigns code-split chunks to their route files and adds the entry's closure to every page", () => {
    const chunks = clientChunksFrom(bundle);
    expect(chunks.find((c) => c.fileName === 'assets/about.js')!.routeFiles).toEqual([
      '/app/src/routes/about.tsx',
    ]);
    expect(routeSources(chunks, ['/app/src/routes/about.tsx'], '/')).toEqual({
      js: ['/assets/index.js', '/assets/react.js', '/assets/about.js', '/assets/shared.js'],
      css: ['/assets/app.css', '/assets/about.css'],
      fonts: [],
      main: ['/assets/index.js'],
    });
    const other = routeSources(chunks, ['/app/src/routes/missing.tsx'], '/shop/');
    expect(other.js).toEqual(['/shop/assets/index.js', '/shop/assets/react.js']);
  });
});

describe('prerendered documents', () => {
  it('maps HTML files to their URLs and finds leaked nonces', () => {
    const dir = temp();
    write(dir, {
      'index.html': '<html><head><script>a()</script></head></html>',
      'about.html': '<html><head><meta property="csp-nonce" content="abc"/></head></html>',
      'docs/index.html': '<html><script nonce="xyz">b()</script></html>',
      '_shell.html': '<html></html>',
      '.vite/manifest.html': 'ignored',
      'assets/app.js': '',
    });
    const docs = findDocuments(dir);
    expect(docs.map((d) => [d.pathname, d.relative])).toEqual([
      ['/', 'index.html'],
      ['/_shell', '_shell.html'],
      ['/about', 'about.html'],
      ['/docs', 'docs/index.html'],
    ]);
    expect(documentsWithNonce(docs).sort()).toEqual(['/about', '/docs']);
    expect(findDocuments(dir, '/shop').map((d) => d.pathname)).toContain('/shop/about');
    expect(findDocuments(join(dir, 'missing'))).toEqual([]);
  });
});

describe('platform output', () => {
  it('maps Nitro presets to targets', () => {
    expect(targetForNitroPreset('vercel')).toBe('vercel');
    expect(targetForNitroPreset('vercel_edge')).toBe('vercel');
    expect(targetForNitroPreset('cloudflare-module')).toBe('cloudflare');
    expect(targetForNitroPreset('node-server')).toBe('node');
    expect(targetForNitroPreset('bun')).toBe('node');
    expect(targetForNitroPreset(undefined)).toBe('node');
  });

  it("gives a Node server's hashed assets the static rules, never documents or the catch-all", () => {
    const rules: StaticHeaderRule[] = [
      { path: '/*', set: { 'x-content-type-options': 'nosniff' } },
      { path: '/assets/*', set: { 'cache-control': 'public, max-age=31536000, immutable' } },
      { path: '/about', set: { 'content-security-policy': "script-src 'self'" } },
    ];
    expect(nodeRouteRules(rules)).toEqual({
      '/assets/**': {
        headers: {
          'x-content-type-options': 'nosniff',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      },
    });
  });

  it('serves prerendered documents at clean URLs on Vercel', () => {
    const out = temp();
    write(out, {
      'config.json': JSON.stringify({ version: 3, overrides: { 'x.html': { path: 'x' } }, routes: [] }),
    });
    const doc = (relative: string, pathname: string) => ({
      relative,
      pathname,
      file: join(out, 'static', relative),
    });
    const mapped = writeVercelOverrides(out, [
      doc('index.html', '/'),
      doc('about.html', '/about'),
      doc('docs/index.html', '/docs'),
    ]);
    expect(mapped).toBe(2);
    const config = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
      overrides: Record<string, unknown>;
    };
    expect(config.overrides).toEqual({
      'x.html': { path: 'x' },
      'about.html': { path: 'about', contentType: 'text/html; charset=utf-8' },
      'docs/index.html': { path: 'docs', contentType: 'text/html; charset=utf-8' },
    });
    expect(writeVercelOverrides(join(out, 'missing'), [])).toBe(0);
  });

  it('removes the prerender token from server bundles and source maps', () => {
    const dir = temp();
    const token = 'T'.repeat(43);
    write(dir, {
      'index.mjs': `const prerenderToken = "${token}";`,
      'chunk.js.map': `{"sourcesContent":["export const prerenderToken = \\"${token}\\";"]}`,
      'other.js': 'nothing here',
      'node_modules/dep/index.js': `"${token}"`,
    });
    const changed = scrubPrerenderToken([dir], token).map((f) => f.slice(dir.length));
    expect(changed.sort()).toEqual(['/chunk.js.map', '/index.mjs']);
    expect(readFileSync(join(dir, 'index.mjs'), 'utf8')).toBe('const prerenderToken = "";');
    expect(scrubPrerenderToken([dir], '')).toEqual([]);
  });
});

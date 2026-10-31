import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BrowserManifest,
  basenamePrefix,
  branchAssets,
  discoverRoutes,
  parseBrowserManifest,
  type RouteManifestEntryLike,
  readBrowserManifest,
  routePath,
  routePattern,
  sourceRendersUi,
} from './routes';

const routes: Record<string, RouteManifestEntryLike> = {
  root: { id: 'root', path: '', file: 'root.tsx' },
  'routes/home': { id: 'routes/home', parentId: 'root', index: true, file: 'routes/home.tsx' },
  'routes/blog': { id: 'routes/blog', parentId: 'root', path: 'blog', file: 'routes/blog.tsx' },
  'routes/blog.index': {
    id: 'routes/blog.index',
    parentId: 'routes/blog',
    index: true,
    file: 'routes/blog._index.tsx',
  },
  'routes/blog.post': {
    id: 'routes/blog.post',
    parentId: 'routes/blog',
    path: ':slug',
    file: 'routes/blog.$slug.tsx',
  },
  'routes/auth': { id: 'routes/auth', parentId: 'root', file: 'routes/_auth.tsx' },
  'routes/login': {
    id: 'routes/login',
    parentId: 'routes/auth',
    path: 'login',
    file: 'routes/_auth.login.tsx',
  },
  'routes/lang': { id: 'routes/lang', parentId: 'root', path: ':lang?/about', file: 'routes/about.tsx' },
  'routes/docs': { id: 'routes/docs', parentId: 'root', path: 'docs/*', file: 'routes/docs.tsx' },
  'routes/api': { id: 'routes/api', parentId: 'root', path: 'api/users/:id', file: 'routes/api.users.ts' },
  'routes/feed': { id: 'routes/feed', parentId: 'root', path: 'feed.xml', file: 'routes/feed.ts' },
};

const route = (id: string, extra: Partial<BrowserManifest['routes'][string]> = {}) => ({
  id,
  module: `/assets/${id.replace(/\W/g, '_')}.js`,
  imports: ['/assets/jsx-runtime.js'],
  css: [],
  hasDefaultExport: true,
  hasErrorBoundary: false,
  ...extra,
});

const browser: BrowserManifest = {
  version: 'abc123',
  entry: { module: '/assets/entry.client.js', imports: ['/assets/jsx-runtime.js'], css: [] },
  routes: {
    root: route('root', { css: ['/assets/root.css'], hasErrorBoundary: true }),
    'routes/home': route('routes/home'),
    'routes/blog': route('routes/blog', { css: ['/assets/blog.css'] }),
    'routes/blog.index': route('routes/blog.index'),
    'routes/blog.post': route('routes/blog.post'),
    'routes/auth': route('routes/auth'),
    'routes/login': route('routes/login'),
    'routes/lang': route('routes/lang'),
    'routes/docs': route('routes/docs'),
    'routes/api': route('routes/api', { hasDefaultExport: false, imports: [] }),
    'routes/feed': route('routes/feed', { hasDefaultExport: false, imports: [] }),
  },
};

describe('route paths and patterns', () => {
  it('joins ancestor paths', () => {
    expect(routePath(routes, 'routes/blog.post')).toBe('blog/:slug');
    expect(routePath(routes, 'routes/login')).toBe('login');
    expect(routePath(routes, 'routes/home')).toBe('');
  });

  it('converts React Router syntax and applies the basename', () => {
    expect(routePattern('blog/:slug')).toBe('/blog/[slug]');
    expect(routePattern(':lang?/about')).toBe('/[[lang]]/about');
    expect(routePattern('docs/*')).toBe('/docs/[...splat]');
    expect(routePattern('')).toBe('/');
    expect(routePattern('about', '/app/')).toBe('/app/about');
    expect(routePattern('', '/app/')).toBe('/app');
    expect(basenamePrefix('/')).toBe('');
    expect(basenamePrefix('/app/')).toBe('/app');
  });
});

describe('discoverRoutes', () => {
  it('finds one route per URL pattern with kinds and assets from the browser manifest', () => {
    const {
      routes: found,
      routeIds,
      warnings,
    } = discoverRoutes({
      routes,
      browser,
      appDirectory: '/project/app',
      root: '/project',
    });
    expect(warnings).toEqual([]);
    const byPath = Object.fromEntries(found.map((r) => [r.pathname, r]));
    expect(Object.keys(byPath).sort()).toEqual(
      [
        '/',
        '/[[lang]]/about',
        '/api/users/[id]',
        '/blog',
        '/blog/[slug]',
        '/docs/[...splat]',
        '/feed.xml',
        '/login',
      ].sort(),
    );
    // The index answers `/blog`, not its layout.
    expect(routeIds['/blog']).toBe('routes/blog.index');
    expect(routeIds['/']).toBe('routes/home');
    expect(byPath['/api/users/[id]']!.kind).toBe('endpoint');
    expect(byPath['/feed.xml']!.kind).toBe('endpoint');
    expect(byPath['/blog/[slug]']!.kind).toBe('page');
    expect(byPath['/login']!.sourcePage).toBe('app/routes/_auth.login.tsx');
    // Pages carry the entry, every route module of their branch and the branch's CSS.
    const blogPost = byPath['/blog/[slug]']!.sources!;
    expect(blogPost.js).toEqual([
      '/assets/entry.client.js',
      '/assets/jsx-runtime.js',
      '/assets/root.js',
      '/assets/routes_blog.js',
      '/assets/routes_blog_post.js',
    ]);
    expect(blogPost.css).toEqual(['/assets/root.css', '/assets/blog.css']);
    expect(blogPost.main).toEqual([
      '/assets/entry.client.js',
      '/assets/root.js',
      '/assets/routes_blog.js',
      '/assets/routes_blog_post.js',
    ]);
    expect(byPath['/api/users/[id]']!.sources).toBeUndefined();
  });

  it('falls back to the module sources without a browser manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-rr-src-'));
    mkdirSync(join(dir, 'routes'));
    writeFileSync(join(dir, 'root.tsx'), 'export default function App() {}');
    writeFileSync(join(dir, 'routes/page.tsx'), 'export default function Page() {}');
    writeFileSync(join(dir, 'routes/api.ts'), 'export function loader() { return Response.json({}) }');
    writeFileSync(join(dir, 'routes/boundary.tsx'), 'export function ErrorBoundary() {}');
    const result = discoverRoutes({
      routes: {
        root: { id: 'root', path: '', file: 'root.tsx' },
        page: { id: 'page', parentId: 'root', path: 'page', file: 'routes/page.tsx' },
        api: { id: 'api', parentId: 'root', path: 'api', file: 'routes/api.ts' },
        boundary: { id: 'boundary', parentId: 'root', path: 'boundary', file: 'routes/boundary.tsx' },
      },
      appDirectory: dir,
    });
    const kinds = Object.fromEntries(result.routes.map((r) => [r.pathname, r.kind]));
    expect(kinds).toEqual({ '/': 'page', '/api': 'endpoint', '/boundary': 'page', '/page': 'page' });
    expect(result.warnings[0]).toContain('no browser manifest');
  });

  it('recognises UI modules from their source', () => {
    expect(sourceRendersUi('export default function X() {}')).toBe(true);
    expect(sourceRendersUi('function X() {}\nexport { X as default }')).toBe(true);
    expect(sourceRendersUi('export const ErrorBoundary = () => null')).toBe(true);
    expect(sourceRendersUi('export async function loader() {}')).toBe(false);
  });
});

describe('browser manifest', () => {
  it('parses manifest-<hash>.js and reads the newest one', () => {
    const source = `window.__reactRouterManifest=${JSON.stringify(browser)};`;
    expect(parseBrowserManifest(source)?.version).toBe('abc123');
    expect(parseBrowserManifest('window.x = 1')).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-rr-manifest-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'assets', 'manifest-old.js'),
      `window.__reactRouterManifest=${JSON.stringify({ ...browser, version: 'old' })};`,
    );
    utimesSync(join(dir, 'assets', 'manifest-old.js'), new Date(1000), new Date(1000));
    writeFileSync(join(dir, 'assets', 'manifest-new.js'), source);
    expect(readBrowserManifest(dir)?.version).toBe('abc123');
    expect(readBrowserManifest(join(dir, 'missing'))).toBeNull();
  });

  it('collects branch assets without duplicates', () => {
    const assets = branchAssets(browser, [{ id: 'root' }, { id: 'routes/home' }, { id: 'unknown' }]);
    expect(assets?.js).toEqual([
      '/assets/entry.client.js',
      '/assets/jsx-runtime.js',
      '/assets/root.js',
      '/assets/routes_home.js',
    ]);
    expect(assets?.css).toEqual(['/assets/root.css']);
  });
});

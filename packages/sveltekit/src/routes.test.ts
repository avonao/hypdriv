import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRouteMatcher } from '@hypdriv/core';
import { toHypRoute } from '@hypdriv/vite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  approximateRegex,
  discoverRoutes,
  routesFromBuilder,
  type SvelteKitRouteLike,
  svelteKitPattern,
} from './routes';

const kitDir = dirname(createRequire(import.meta.url).resolve('@sveltejs/kit/package.json'));
const kitRouting = (await import(pathToFileURL(join(kitDir, 'src/utils/routing.js')).href)) as {
  parse_route_id(id: string): { pattern: RegExp };
};

function kitRoute(id: string, extra: Partial<SvelteKitRouteLike> = {}): SvelteKitRouteLike {
  return {
    id,
    pattern: kitRouting.parse_route_id(id).pattern,
    prerender: false,
    page: { methods: ['GET'] },
    api: { methods: [] },
    config: {},
    ...extra,
  };
}

describe('svelteKitPattern', () => {
  it.each([
    ['/', '/', true],
    ['/about', '/about', true],
    ['/(marketing)/pricing', '/pricing', true],
    ['/(app)/(nested)/settings', '/settings', true],
    ['/blog/[slug]', '/blog/[slug]', true],
    ['/blog/[id=integer]', '/blog/[id]', true],
    ['/[[lang]]/about', '/[[lang]]/about', true],
    ['/[[lang=locale]]/about', '/[[lang]]/about', true],
    ['/files/[...path]', '/files/[...path]', true],
    ['/files/[...path=file]', '/files/[...path]', true],
    ['/[x+2e]well-known/[x+2e]x', '/.well-known/.x', true],
    ['/caf[u+00e9]', '/caf%C3%A9', true],
    ['/a/[x]-[y]', '/a/[x_y]', false],
    ['/v[major].json', '/[major]', false],
    ['/assets/[...file].png', '/assets/[...file]', false],
  ])('%s → %s', (id, pathname, exact) => {
    expect(svelteKitPattern(id)).toEqual({ pathname, exact });
  });
});

describe('approximateRegex', () => {
  it.each([
    '/',
    '/(app)/blog/[slug]',
    '/files/[...path]',
    '/[[lang]]/about',
    '/a/[x]-[y]',
    '/v[major].json',
    '/[id=integer]',
    '/x/[[opt]]/[...rest]',
    '/.well-known/[x+2e]x',
    '/(group)',
  ])("matches SvelteKit's own pattern for %s", (id) => {
    expect(approximateRegex(id)).toBe(kitRouting.parse_route_id(id).pattern.source);
  });
});

describe('routesFromBuilder', () => {
  it('classifies pages, endpoints, prerendered routes and adapter-vercel ISR', () => {
    const routes = routesFromBuilder({
      routes: [
        kitRoute('/', { prerender: true }),
        kitRoute('/(app)/dashboard'),
        kitRoute('/api/hello', { page: { methods: [] }, api: { methods: ['GET', 'POST'] } }),
        kitRoute('/sitemap.xml', { page: { methods: [] }, api: { methods: ['GET'] }, prerender: true }),
        kitRoute('/feed.json', { page: { methods: [] }, api: { methods: ['GET'] }, prerender: 'auto' }),
        kitRoute('/blog/[slug]', { prerender: 'auto' }),
        kitRoute('/news', { config: { isr: { expiration: 60 } } }),
        kitRoute('/a/[x]-[y]'),
        kitRoute('/layout-only', { page: { methods: [] }, api: { methods: [] } }),
      ],
      prerenderedEndpoints: ['/feed.json'],
    });
    expect(routes.map((r) => [r.frameworkId, r.pathname, r.kind, r.prerendered ?? null])).toEqual([
      ['/', '/', 'page', true],
      ['/(app)/dashboard', '/dashboard', 'page', null],
      ['/api/hello', '/api/hello', 'endpoint', null],
      ['/sitemap.xml', '/sitemap.xml', 'endpoint', true],
      ['/feed.json', '/feed.json', 'endpoint', true],
      ['/blog/[slug]', '/blog/[slug]', 'page', null],
      ['/news', '/news', 'page', true],
      ['/a/[x]-[y]', '/a/[x_y]', 'page', null],
    ]);
    const news = routes.find((r) => r.pathname === '/news')!;
    expect(news.revalidate).toBe(60);
    expect(toHypRoute(news).classification).toBe('isr');
    const mixed = routes.find((r) => r.pathname === '/a/[x_y]')!;
    expect(mixed.regex).toBe('^\\/a\\/([^/]+?)-([^/]+?)\\/?$');
    const matcher = createRouteMatcher({
      routes: routes.map((r) => toHypRoute(r)),
      basePath: '',
      trailingSlash: false,
    });
    expect(matcher.match('/a/one-two')?.route.pathname).toBe('/a/[x_y]');
    expect(matcher.match('/blog/hello')?.route.pathname).toBe('/blog/[slug]');
    expect(matcher.match('/dashboard')?.route.kind).toBe('page');
  });

  it('attaches client assets to pages and source files when the routes directory is known', () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-sk-routes-'));
    mkdirSync(join(root, 'src/routes/(app)/dashboard'), { recursive: true });
    writeFileSync(join(root, 'src/routes/(app)/dashboard/+page.svelte'), '<h1>x</h1>');
    mkdirSync(join(root, 'src/routes/api/hello'), { recursive: true });
    writeFileSync(join(root, 'src/routes/api/hello/+server.ts'), 'export const GET = () => new Response()');
    const assets = new Map([
      ['/(app)/dashboard', { js: ['/_app/a.js'], css: [], fonts: [], main: ['/_app/a.js'] }],
    ]);
    const routes = routesFromBuilder({
      routes: [
        kitRoute('/(app)/dashboard'),
        kitRoute('/api/hello', { page: { methods: [] }, api: { methods: ['GET'] } }),
      ],
      root,
      routesDir: 'src/routes',
      assets,
    });
    expect(routes[0]).toMatchObject({
      sourcePage: 'src/routes/(app)/dashboard/+page.svelte',
      sources: { js: ['/_app/a.js'] },
    });
    expect(routes[1]).toMatchObject({ sourcePage: 'src/routes/api/hello/+server.ts' });
    expect(routes[1]!.sources).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('discoverRoutes', () => {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-sk-discover-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const file = (path: string, content = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  it('finds pages and endpoints in src/routes', () => {
    file('src/routes/+page.svelte');
    file('src/routes/+layout.svelte');
    file('src/routes/(marketing)/pricing/+page.svelte');
    file('src/routes/blog/[slug]/+page.server.ts');
    file('src/routes/blog/[slug]/+page.svelte');
    file('src/routes/api/items/[id=integer]/+server.ts');
    file('src/routes/files/[name].[ext]/+server.js');
    file('src/routes/settings/+page@.svelte');
    file('src/routes/only-layout/+layout.svelte');
    file('src/routes/tests/+page.test.ts');
    expect(discoverRoutes(root).map((r) => [r.frameworkId, r.pathname, r.kind, r.regex ?? null])).toEqual([
      ['/', '/', 'page', null],
      ['/(marketing)/pricing', '/pricing', 'page', null],
      ['/api/items/[id=integer]', '/api/items/[id]', 'endpoint', null],
      ['/blog/[slug]', '/blog/[slug]', 'page', null],
      ['/files/[name].[ext]', '/files/[name_ext]', 'endpoint', '^\\/files\\/([^/]+?)\\.([^/]+?)\\/?$'],
      ['/settings', '/settings', 'page', null],
    ]);
  });

  it('accepts the absolute routes directory SvelteKit resolves `files.routes` to', () => {
    expect(discoverRoutes(root, join(root, 'src/routes'))).toHaveLength(6);
  });

  it('returns nothing without a routes directory', () => {
    expect(discoverRoutes(join(root, 'missing'))).toEqual([]);
  });
});

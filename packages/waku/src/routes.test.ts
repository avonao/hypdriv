import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverFileRoutes, discoverRoutes, pagePattern, readPageConfig, scanCreatePages } from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): { root: string; srcDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-waku-routes-'));
  dirs.push(root);
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return { root, srcDir: join(root, 'src') };
}

const component = 'export default function Page() { return null; }\n';
const dynamic = `${component}export const getConfig = async () => ({ render: 'dynamic' }) as const;\n`;
const staticPaths = (paths: string) =>
  `${component}export const getConfig = async () => ({ render: 'static', staticPaths: ${paths} }) as const;\n`;

describe('pagePattern', () => {
  it('maps file router paths to Hypdriv patterns', () => {
    expect(pagePattern(['index'])).toBe('/');
    expect(pagePattern(['about'])).toBe('/about');
    expect(pagePattern(['about', 'index'])).toBe('/about');
    expect(pagePattern(['blog', '[slug]'])).toBe('/blog/[slug]');
    expect(pagePattern(['docs', '[...rest]'])).toBe('/docs/[...rest]');
    expect(pagePattern(['(marketing)', 'pricing'])).toBe('/pricing');
    expect(pagePattern(['(marketing)', 'index'])).toBe('/');
  });

  it('skips layouts, roots and the directories the router ignores', () => {
    expect(pagePattern(['_layout'])).toBeNull();
    expect(pagePattern(['blog', '_layout'])).toBeNull();
    expect(pagePattern(['_root'])).toBeNull();
    expect(pagePattern(['_components', 'Card'])).toBeNull();
    expect(pagePattern(['blog', '_hooks', 'use-post'])).toBeNull();
    expect(pagePattern(['_actions', 'save'])).toBeNull();
  });
});

describe('readPageConfig', () => {
  it('reads render and staticPaths from getConfig', () => {
    expect(readPageConfig(dynamic)).toEqual({ render: 'dynamic', staticPaths: false });
    expect(readPageConfig(staticPaths("['a', 'b']"))).toEqual({ render: 'static', staticPaths: true });
    expect(readPageConfig(component)).toEqual({ staticPaths: false });
  });
});

describe('discoverFileRoutes', () => {
  it('finds pages, slug pages, wildcard pages, groups and API routes', () => {
    const { root, srcDir } = project({
      'src/pages/_root.tsx': component,
      'src/pages/_layout.tsx': component,
      'src/pages/index.tsx': component,
      'src/pages/about.tsx': component,
      'src/pages/blog/[slug].tsx': staticPaths("['a', 'b']"),
      'src/pages/shop/[id].tsx': component,
      'src/pages/docs/[...rest].tsx': dynamic,
      'src/pages/(marketing)/pricing.tsx': dynamic,
      'src/pages/nested/_layout.tsx': component,
      'src/pages/nested/index.tsx': component,
      'src/pages/_api/hello.ts': 'export const GET = () => new Response("hi");\n',
      'src/pages/_api/feed.xml.ts': `export const GET = () => new Response("<feed/>");\nexport const getConfig = async () => ({ render: 'static' }) as const;\n`,
      'src/pages/_api/items/[id].ts': 'export const GET = () => new Response("item");\n',
      'src/pages/_slices/banner.tsx': component,
      'src/pages/_interceptors/auth.ts': component,
      'src/pages/_components/Card.tsx': component,
      'src/pages/types.d.ts': 'export {};\n',
    });
    const routes = discoverFileRoutes(root, { srcDir });
    const byKey = Object.fromEntries(routes.map((r) => [`${r.kind}:${r.pathname}`, r]));
    expect(Object.keys(byKey).sort()).toEqual(
      [
        'endpoint:/feed.xml',
        'endpoint:/hello',
        'endpoint:/items/[id]',
        'page:/',
        'page:/about',
        'page:/blog/[slug]',
        'page:/docs/[...rest]',
        'page:/nested',
        'page:/pricing',
        'page:/shop/[id]',
      ].sort(),
    );
    // Static pages (the default) are prerendered; slug pages only with staticPaths; dynamic ones never.
    expect(byKey['page:/']?.prerendered).toBe(true);
    expect(byKey['page:/blog/[slug]']?.prerendered).toBe(true);
    expect(byKey['page:/shop/[id]']?.prerendered).toBeUndefined();
    expect(byKey['page:/docs/[...rest]']?.prerendered).toBeUndefined();
    expect(byKey['page:/pricing']?.prerendered).toBeUndefined();
    expect(byKey['endpoint:/feed.xml']?.prerendered).toBe(true);
    expect(byKey['endpoint:/hello']?.prerendered).toBeUndefined();
    expect(byKey['page:/about']?.sourcePage).toBe('src/pages/about.tsx');
  });

  it('honours the router options and a missing pages directory', () => {
    const { root, srcDir } = project({
      'src/routes/index.tsx': component,
      'src/routes/_endpoints/ping.ts': 'export const GET = () => new Response("pong");\n',
    });
    expect(discoverFileRoutes(root, { srcDir })).toEqual([]);
    const routes = discoverFileRoutes(root, { srcDir, pagesDir: 'routes', apiDir: '_endpoints' });
    expect(routes.map((r) => `${r.kind}:${r.pathname}`).sort()).toEqual(['endpoint:/ping', 'page:/']);
  });
});

describe('scanCreatePages', () => {
  it('reads literal paths and render modes of createPage and createApi calls', () => {
    const source = `
      export default adapter(createPages(async ({ createPage, createLayout, createApi }) => [
        createLayout({ render: 'static', path: '/', component: Layout }),
        createPage({ render: 'static', path: '/', component: Home }),
        createPage({ render: 'dynamic', path: '/account/[tab]', component: Account }),
        createPage({ render: 'static', path: '/blog/[slug]', staticPaths: ['a'], component: Post }),
        createPage({ render: 'static', path: '/docs/[...rest]', component: Docs }),
        createPage({ render: 'static', path: '/(shop)/cart', component: Cart }),
        createPage({ render: 'static', path: base + '/computed', component: Computed }),
        // createPage({ render: 'static', path: '/commented', component: Nope }),
        createApi({ path: '/health', render: 'dynamic', method: 'GET', handler: async () => new Response('ok') }),
        createApi({ path: '/sitemap.xml', render: 'static', method: 'GET', handler: sitemap }),
      ]));
    `;
    const routes = scanCreatePages(source, 'src/waku.server.tsx');
    expect(routes.map((r) => `${r.kind}:${r.pathname}:${r.prerendered ? 'static' : 'dynamic'}`)).toEqual([
      'page:/:static',
      'page:/account/[tab]:dynamic',
      'page:/blog/[slug]:static',
      'page:/docs/[...rest]:dynamic',
      'page:/cart:static',
      'endpoint:/health:dynamic',
      'endpoint:/sitemap.xml:static',
    ]);
    expect(routes[0]?.sourcePage).toBe('src/waku.server.tsx');
  });
});

describe('discoverRoutes', () => {
  it('adds the routes of a custom server entry to the file router ones', () => {
    const { root, srcDir } = project({
      'src/pages/index.tsx': component,
      'src/waku.server.tsx': `createPage({ render: 'dynamic', path: '/live', component: Live });\ncreatePage({ render: 'static', path: '/', component: Home });\n`,
    });
    const routes = discoverRoutes(root, { srcDir });
    expect(routes.map((r) => `${r.kind}:${r.pathname}`).sort()).toEqual(['page:/', 'page:/live']);
    // The file router's entry for `/` wins over the one found in the server entry.
    expect(routes.find((r) => r.pathname === '/')?.sourcePage).toBe('src/pages/index.tsx');
  });
});

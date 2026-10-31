import { describe, expect, it } from 'vitest';
import { discoverRoutes, flattenPages, fromNitroRoute, pageRoutes, serverRoutes } from './routes';
import { isStaticPreset, supportsWorkerEntry, targetOfPreset } from './targets';

const root = '/app';

describe('flattenPages', () => {
  it('resolves nested children against their parents; index children take the parent path', () => {
    const flat = flattenPages([
      { path: '/', name: 'index', file: '/app/app/pages/index.vue' },
      {
        path: '/blog',
        file: '/app/app/pages/blog.vue',
        children: [
          { path: '', name: 'blog', file: '/app/app/pages/blog/index.vue' },
          { path: ':slug()', name: 'blog-slug', file: '/app/app/pages/blog/[slug].vue' },
        ],
      },
      { path: '/settings', children: [{ path: '/settings/profile', name: 'profile' }] },
    ]);
    expect(flat).toEqual([
      { path: '/', name: 'index', file: '/app/app/pages/index.vue' },
      { path: '/blog', name: 'blog', file: '/app/app/pages/blog/index.vue' },
      { path: '/blog/:slug()', name: 'blog-slug', file: '/app/app/pages/blog/[slug].vue' },
      { path: '/settings' },
      { path: '/settings/profile', name: 'profile' },
    ]);
  });
});

describe('pageRoutes', () => {
  it('converts Vue Router paths to canonical patterns with project-relative sources', () => {
    const routes = pageRoutes(
      [
        { path: '/', name: 'index', file: '/app/app/pages/index.vue' },
        { path: '/p/:slug()', name: 'p-slug', file: '/app/app/pages/p/[slug].vue' },
        { path: '/:lang?/about', file: '/app/app/pages/[[lang]]/about.vue' },
        { path: '/docs/:path(.*)*', file: '/app/app/pages/docs/[...path].vue' },
      ],
      root,
    );
    expect(routes.map((r) => [r.pathname, r.sourcePage])).toEqual([
      ['/', 'app/pages/index.vue'],
      ['/p/[slug]', 'app/pages/p/[slug].vue'],
      ['/[[lang]]/about', 'app/pages/[[lang]]/about.vue'],
      ['/docs/[[...path]]', 'app/pages/docs/[...path].vue'],
    ]);
    expect(routes.every((r) => r.kind === 'page')).toBe(true);
    expect(routes[1]?.frameworkId).toBe('p-slug');
  });
});

describe('fromNitroRoute', () => {
  it('converts radix3 parameters and wildcards', () => {
    expect(fromNitroRoute('/api/hello')).toBe('/api/hello');
    expect(fromNitroRoute('/api/users/:id')).toBe('/api/users/[id]');
    expect(fromNitroRoute('/api/files/**:path')).toBe('/api/files/[[...path]]');
    expect(fromNitroRoute('/proxy/**')).toBe('/proxy/[[...path]]');
    expect(fromNitroRoute('/a/*/b/*')).toBe('/a/[_]/b/[_1]');
    expect(fromNitroRoute('/')).toBe('/');
  });
});

describe('serverRoutes', () => {
  it('keeps API and server routes, dropping middleware, the renderer and Nuxt internals', () => {
    const routes = serverRoutes(
      [
        { route: '/api/hello', method: 'get', handler: '/app/server/api/hello.get.ts' },
        { route: '/api/hello', method: 'post', handler: '/app/server/api/hello.post.ts' },
        { route: '/api/users/:id', handler: '/app/server/api/users/[id].ts' },
        { middleware: true, handler: '/app/server/middleware/log.ts' },
        { route: '/__nuxt_error', handler: '/nuxt/renderer.mjs' },
        { route: '/__nuxt_island/**', handler: '/nuxt/island.mjs' },
        { route: '/**', handler: '/nuxt/renderer.mjs' },
        { route: '/feed.xml', handler: '/app/server/routes/feed.xml.ts' },
      ],
      { exclude: ['/nuxt/renderer.mjs'] },
    );
    expect(routes.map((r) => [r.pathname, r.kind])).toEqual([
      ['/api/hello', 'endpoint'],
      ['/api/users/[id]', 'endpoint'],
      ['/feed.xml', 'endpoint'],
    ]);
  });
});

describe('discoverRoutes', () => {
  it('lists pages first and never an endpoint that shadows a page', () => {
    const routes = discoverRoutes({
      pages: [{ path: '/', file: '/app/app/pages/index.vue' }],
      handlers: [
        { route: '/', handler: '/app/server/routes/index.ts' },
        { route: '/api/x', handler: 'x' },
      ],
      rootDir: root,
    });
    expect(routes.map((r) => `${r.kind}:${r.pathname}`)).toEqual(['page:/', 'endpoint:/api/x']);
  });

  it('describes an app without pages as one catch-all page (app.vue renders every path)', () => {
    const routes = discoverRoutes({ pages: null, handlers: [], rootDir: root });
    expect(routes).toEqual([{ pathname: '/[[...path]]', kind: 'page' }]);
  });
});

describe('presets', () => {
  it('maps Nitro presets to deployment targets', () => {
    expect(targetOfPreset('cloudflare-module')).toBe('cloudflare');
    expect(targetOfPreset('cloudflare_module')).toBe('cloudflare');
    expect(targetOfPreset('cloudflare-pages')).toBe('cloudflare');
    expect(targetOfPreset('vercel')).toBe('vercel');
    expect(targetOfPreset('vercel-edge')).toBe('vercel');
    expect(targetOfPreset('node-server')).toBe('node');
    expect(targetOfPreset(undefined)).toBe('node');
  });

  it('knows which presets get HypDriv’s Worker entry and which are static', () => {
    expect(supportsWorkerEntry('cloudflare-module')).toBe(true);
    expect(supportsWorkerEntry('cloudflare_module')).toBe(true);
    expect(supportsWorkerEntry('cloudflare-pages')).toBe(false);
    expect(supportsWorkerEntry('cloudflare-durable')).toBe(false);
    expect(isStaticPreset('static')).toBe(true);
    expect(isStaticPreset('vercel-static')).toBe(true);
    expect(isStaticPreset('node-server')).toBe(false);
  });
});

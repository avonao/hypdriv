import { createRouteMatcher, emptyManifest, type HypManifest, routePatternToRegex } from '@hypdriv/core';
import { except, index, layout, prefix, render, route } from 'rwsdk/router';
import { describe, expect, it } from 'vitest';
import { appManifest, appRoutes, handlerKind, manifestRoutes, rwsdkPattern } from './routes';

// RedwoodSDK compiles JSX to calls of the JSX runtime (`jsx(...)`), and its router tells pages from endpoints by
// looking for that in the handler's source. These stand in for compiled components.
const jsx = (tag: string): never => ({ tag }) as never;
const Home = () => jsx('main');
const Post = ({ params }: { params: { id: string } }) => jsx(params.id);
const Admin = () => jsx('admin');
const Shell = ({ children }: { children?: unknown }) => jsx(String(children));
const Document = ({ children }: { children?: unknown }) => jsx(String(children));
const ping = () => Response.json({ ok: true });
const requireUser = () => undefined;

const client = Object.assign(() => 'x', { $$isClientReference: true });
const marked = Object.assign(() => 'x', { __rwsdk_route_component: true });

describe('rwsdkPattern', () => {
  it.each([
    ['/', '/'],
    ['/about/', '/about'],
    ['/users/:id/', '/users/[id]'],
    ['/users/:id/posts/:postId/', '/users/[id]/posts/[postId]'],
    ['/files/*', '/files/[...splat]'],
    ['/files/*/', '/files/[...splat]'],
    ['/*', '/[...splat]'],
    ['/api/*/download/', '/api/[splat]/download'],
    ['/a/*/b/*/c/', '/a/[splat]/b/[splat1]/c'],
    // The trailing catch-all never reuses the name of an earlier wildcard or of a `:splat` parameter.
    ['/a/*/b/*', '/a/[splat]/b/[...splat1]'],
    ['/*/x/*', '/[splat]/x/[...splat1]'],
    ['/:splat/*', '/[splat]/[...splat1]'],
    ['/:splat/:splat1/*/y/*', '/[splat]/[splat1]/[splat2]/y/[...splat3]'],
    // A parameter inside a segment (`v:version`, `:name.pdf`) matches the whole segment in Hypdriv's syntax.
    ['/v:version/', '/[version]'],
    ['/reports/:name.pdf/', '/reports/[name]'],
    ['/blog//post/', '/blog/post'],
  ])('%s → %s', (path, pattern) => {
    expect(rwsdkPattern(path)).toBe(pattern);
  });

  it.each(['/a/*/b/*', '/*/x/*', '/:splat/*', '/:id/*/:name/*/*'])(
    'compiles %s to a route expression (no duplicate capture group)',
    (path) => {
      expect(() => new RegExp(routePatternToRegex(rwsdkPattern(path)))).not.toThrow();
    },
  );
});

describe('handlerKind', () => {
  it('calls a handler that renders JSX a page and one that returns a Response an endpoint', () => {
    expect(handlerKind(Home)).toBe('page');
    expect(handlerKind(ping)).toBe('endpoint');
  });

  it('knows client references and the components RedwoodSDK already marked', () => {
    expect(handlerKind(client)).toBe('page');
    expect(handlerKind(marked)).toBe('page');
  });

  it('lets the last entry of a middleware array decide', () => {
    expect(handlerKind([requireUser, Home])).toBe('page');
    expect(handlerKind([requireUser, ping])).toBe('endpoint');
    expect(handlerKind([])).toBe('endpoint');
  });

  it('calls a method table a page only when its GET renders', () => {
    expect(handlerKind({ get: Home, post: ping })).toBe('page');
    expect(handlerKind({ get: ping, post: ping })).toBe('endpoint');
    expect(handlerKind({ post: ping })).toBe('endpoint');
    expect(handlerKind({ get: [requireUser, Home] })).toBe('page');
  });

  it('treats anything else as an endpoint', () => {
    expect(handlerKind(undefined)).toBe('endpoint');
    expect(handlerKind(null)).toBe('endpoint');
    expect(handlerKind('x')).toBe('endpoint');
  });
});

/** What `defineApp(routes)` returns, without running RedwoodSDK's Worker runtime. */
const app = (routes: unknown[]) => ({ __rwRoutes: routes, fetch: async () => new Response('ok') });

describe('appRoutes', () => {
  it('reads the routes RedwoodSDK’s own helpers built: render, layout, prefix, index, except and middleware', () => {
    const routes = appRoutes(
      app([
        requireUser,
        render(Document, [
          index(Home),
          route('/about', Home),
          prefix('/blog', [
            route('/', Home),
            route('/post/:id', Post),
            except(() => new Response('blog error')),
          ]),
          layout(Shell, [route('/admin', [requireUser, Admin])]),
        ]),
        route('/api/ping', { get: ping }),
        route('/api/items/:id', { get: ping, post: ping, delete: ping }),
        route('/files/*', ping),
        except(() => new Response('error')),
      ]),
    );
    expect(routes.map((r) => [r.path, r.kind])).toEqual([
      ['/', 'page'],
      ['/about/', 'page'],
      ['/blog/', 'page'],
      ['/blog/post/:id/', 'page'],
      ['/admin/', 'page'],
      ['/api/ping/', 'endpoint'],
      ['/api/items/:id/', 'endpoint'],
      ['/files/*/', 'endpoint'],
    ]);
  });

  it('lists the verbs of method tables, custom ones included', () => {
    const routes = appRoutes(
      app([
        route('/api/items', { get: ping, post: ping, custom: { purge: ping } }),
        route('/page', Home),
        route('/ping', ping),
      ]),
    );
    expect(routes.map((r) => r.methods)).toEqual([['GET', 'POST', 'PURGE'], [], []]);
  });

  it('returns no routes for an app without a route table', () => {
    expect(appRoutes({})).toEqual([]);
    expect(appRoutes({ __rwRoutes: 'nope' })).toEqual([]);
    expect(appRoutes({ __rwRoutes: [null, undefined, 3, {}] })).toEqual([]);
  });

  it('reads deeply nested arrays and stops at absurd depth', () => {
    let nested: unknown = [route('/deep', Home)];
    for (let i = 0; i < 10; i++) nested = [nested];
    expect(appRoutes(app([nested as never])).map((r) => r.path)).toEqual(['/deep/']);
    for (let i = 0; i < 100; i++) nested = [nested];
    expect(appRoutes(app([nested as never]))).toEqual([]);
  });
});

describe('manifestRoutes', () => {
  const routes = manifestRoutes(
    appRoutes(
      app([
        render(Document, [index(Home), route('/posts/:id', Post), route('/files/*', Home)]),
        route('/api/ping', { get: ping }),
        route('/api/ping', { post: ping }),
      ]),
    ),
  );

  it('makes pages dynamic routes and endpoints routes, one per id', () => {
    expect(routes.map((r) => [r.id, r.pathname, r.kind, r.classification, r.dynamic])).toEqual([
      ['page:/', '/', 'page', 'dynamic', false],
      ['page:/posts/[id]', '/posts/[id]', 'page', 'dynamic', true],
      ['page:/files/[...splat]', '/files/[...splat]', 'page', 'dynamic', true],
      ['endpoint:/api/ping', '/api/ping', 'endpoint', 'route', false],
    ]);
  });

  it('gives the matcher what it needs to find the route of a request', () => {
    const matcher = createRouteMatcher(emptyManifest({ routes }));
    expect(matcher.match('/')?.route.id).toBe('page:/');
    expect(matcher.match('/posts/42')?.route.id).toBe('page:/posts/[id]');
    expect(matcher.match('/files/a/b/c')?.route.id).toBe('page:/files/[...splat]');
    expect(matcher.match('/api/ping')?.route.id).toBe('endpoint:/api/ping');
    expect(matcher.match('/nope')).toBeNull();
  });
});

describe('appManifest', () => {
  const build = (): HypManifest =>
    emptyManifest({
      buildId: 'build-1',
      framework: { name: 'rwsdk', version: '1.7.5', bundler: 'vite', adapter: 'cloudflare' },
      routes: [
        {
          id: 'page:/',
          pathname: '/',
          regex: '^/$',
          kind: 'page',
          classification: 'dynamic',
          runtime: 'nodejs',
          dynamic: false,
          assets: { js: ['/assets/client-abc.js'], css: ['/assets/app.css'], fonts: [] },
          sourcePage: 'src/worker.tsx',
        },
        {
          id: 'page:/stale',
          pathname: '/stale',
          regex: '^/stale$',
          kind: 'page',
          classification: 'dynamic',
          runtime: 'nodejs',
          dynamic: false,
          assets: { js: [], css: [], fonts: [] },
        },
      ],
      csp: { 'page:/': { scriptHashes: ['sha256-x'] } as never },
      warnings: ['from the build'],
    });

  it('takes the routes of the running app and keeps what the build learned about the ones it also found', () => {
    const manifest = appManifest(app([index(Home), route('/computed', Home)]), build());
    expect(manifest.routes.map((r) => r.id)).toEqual(['page:/', 'page:/computed']);
    const home = manifest.routes[0];
    expect(home?.assets).toEqual({ js: ['/assets/client-abc.js'], css: ['/assets/app.css'], fonts: [] });
    expect(home?.sourcePage).toBe('src/worker.tsx');
    expect(manifest.routes[1]?.assets).toEqual({ js: [], css: [], fonts: [] });
    // Everything else is the build's.
    expect(manifest.buildId).toBe('build-1');
    expect(manifest.framework?.version).toBe('1.7.5');
    expect(manifest.warnings).toEqual(['from the build']);
    expect(manifest.csp['page:/']).toBeDefined();
  });

  it('keeps the build’s routes when the app has no readable route table', () => {
    const manifest = appManifest({}, build());
    expect(manifest.routes.map((r) => r.id)).toEqual(['page:/', 'page:/stale']);
  });

  it('builds a manifest from the routes alone without a build', () => {
    const manifest = appManifest(app([index(Home)]), null, { version: '1.7.5' });
    expect(manifest.buildId).toBe('runtime');
    expect(manifest.framework).toEqual({ name: 'rwsdk', version: '1.7.5' });
    expect(manifest.routes.map((r) => r.id)).toEqual(['page:/']);
    expect(appManifest(app([]), null).framework?.version).toBe('unknown');
  });
});

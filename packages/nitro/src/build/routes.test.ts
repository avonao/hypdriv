import { describe, expect, it } from 'vitest';
import {
  discoverNitroRoutes,
  fromNitroRoute,
  isInternalRoute,
  type NitroHandlerLike,
  rendererRoute,
  serverRoutes,
} from './routes';

describe('fromNitroRoute', () => {
  it('converts rou3 / radix3 syntax to canonical patterns', () => {
    expect(fromNitroRoute('/')).toBe('/');
    expect(fromNitroRoute('/users/:id')).toBe('/users/[id]');
    expect(fromNitroRoute('/files/**:path')).toBe('/files/[[...path]]');
    expect(fromNitroRoute('/proxy/**')).toBe('/proxy/[[...path]]');
    expect(fromNitroRoute('/a/*')).toBe('/a/[_]');
    expect(fromNitroRoute('/a/*/b/*')).toBe('/a/[_]/b/[_1]');
  });
});

describe('isInternalRoute', () => {
  it('flags Hypdriv, Nitro and build-asset paths', () => {
    expect(isInternalRoute('/_hypdriv/health')).toBe(true);
    expect(isInternalRoute('/__nitro/x')).toBe(true);
    expect(isInternalRoute('/_nitro/tasks')).toBe(true);
    expect(isInternalRoute('/assets/app.js', ['/assets/'])).toBe(true);
    expect(isInternalRoute('/assets', ['/assets/'])).toBe(true);
    expect(isInternalRoute('/assetsx', ['/assets/'])).toBe(false);
    expect(isInternalRoute('/api/x')).toBe(false);
  });
});

describe('serverRoutes', () => {
  const handlers: NitroHandlerLike[] = [
    { route: '/api/hello', method: 'get', handler: '/app/server/api/hello.get.ts' },
    { route: '/api/users/:id', method: 'get' },
    { route: '/api/users', method: 'post' },
    { route: '/feed', method: '' },
    { route: '/form', method: 'post' },
    { route: '/guard', middleware: true },
    { route: '/assets/x.js' },
    { route: '/**', handler: '/nitro/renderer-template.mjs' },
    { route: '/api/hello', method: 'get' },
  ];

  it('classifies API routes and non-GET handlers as endpoints and GET routes elsewhere as pages', () => {
    const routes = serverRoutes(handlers, {
      assetPrefixes: ['/assets/'],
      exclude: ['/nitro/renderer-template.mjs'],
    });
    expect(routes.map((r) => [r.pathname, r.kind])).toEqual([
      ['/api/hello', 'endpoint'],
      ['/api/users/[id]', 'endpoint'],
      ['/api/users', 'endpoint'],
      ['/feed', 'page'],
      ['/form', 'endpoint'],
    ]);
  });

  it('treats a catch-all handler as a catch-all page', () => {
    const routes = serverRoutes([{ route: '/**', handler: '/app/server/routes/[...].ts' }]);
    expect(routes).toEqual([{ pathname: '/[[...path]]', kind: 'page', frameworkId: '/**' }]);
  });

  it('honours the application’s own page predicate', () => {
    const routes = serverRoutes([{ route: '/data', method: 'get' }], { isPage: () => false });
    expect(routes[0]?.kind).toBe('endpoint');
  });

  it('matches the renderer by file whatever its extension', () => {
    const routes = serverRoutes([{ route: '/**', handler: '/nitro/renderer-template' }], {
      exclude: ['/nitro/renderer-template.mjs'],
    });
    expect(routes).toEqual([]);
  });
});

describe('rendererRoute', () => {
  it('describes a template as a fallback document and a handler as a dynamic catch-all', () => {
    expect(rendererRoute({ template: '/app/index.html' })).toEqual({
      pathname: '/[[...path]]',
      kind: 'page',
      fallback: true,
    });
    expect(rendererRoute({ template: '/app/index.html', static: false })).toEqual({
      pathname: '/[[...path]]',
      kind: 'page',
    });
    expect(rendererRoute('/app/renderer.ts')).toEqual({ pathname: '/[[...path]]', kind: 'page' });
    expect(rendererRoute({ handler: '/app/renderer.ts' })).toEqual({
      pathname: '/[[...path]]',
      kind: 'page',
    });
    expect(rendererRoute(false)).toBeNull();
    expect(rendererRoute(undefined)).toBeNull();
  });
});

describe('discoverNitroRoutes', () => {
  it('lists the framework’s pages first, then handlers, and does not add the renderer next to pages', () => {
    const routes = discoverNitroRoutes({
      pages: [
        { pathname: '/', kind: 'page' },
        { pathname: '/about', kind: 'page' },
      ],
      handlers: [
        { route: '/api/hello', method: 'get' },
        { route: '/about', method: 'get' },
        { route: '/**', handler: '/nitro/renderer.ts' },
      ],
      renderer: '/nitro/renderer.ts',
    });
    expect(routes.map((r) => `${r.kind}:${r.pathname}`)).toEqual([
      'page:/',
      'page:/about',
      'endpoint:/api/hello',
    ]);
  });

  it('adds the renderer’s catch-all for an app without pages', () => {
    const routes = discoverNitroRoutes({
      handlers: [{ route: '/api/hello', method: 'get' }],
      renderer: { template: '/app/index.html' },
    });
    expect(routes.map((r) => `${r.kind}:${r.pathname}`)).toEqual([
      'endpoint:/api/hello',
      'page:/[[...path]]',
    ]);
    expect(routes[1]?.fallback).toBe(true);
  });
});

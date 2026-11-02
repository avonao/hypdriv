import { emptyManifest, type HypRoute, routePatternToRegex } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { normalizeRequestPath, prerenderedPaths } from './prerendered';

const page = (pathname: string, extra: Partial<HypRoute>): HypRoute => ({
  id: `page:${pathname}`,
  pathname,
  regex: routePatternToRegex(pathname),
  kind: 'page',
  classification: 'static',
  runtime: 'nodejs',
  dynamic: false,
  assets: { js: [], css: [], fonts: [] },
  ...extra,
});

describe('prerendered paths (Cloudflare Worker entry)', () => {
  it('normalises request paths to document paths', () => {
    expect(normalizeRequestPath('/')).toBe('/');
    expect(normalizeRequestPath('/about/')).toBe('/about');
    expect(normalizeRequestPath('/about/index.html')).toBe('/about');
    expect(normalizeRequestPath('/index.html')).toBe('/');
    expect(normalizeRequestPath('/caf%C3%A9')).toBe('/café');
    expect(normalizeRequestPath('/%E0%A4%A')).toBe('/%E0%A4%A');
  });

  it('collects static pages and the prerendered paths of dynamic pages', () => {
    const paths = prerenderedPaths(
      emptyManifest({
        routes: [
          page('/', {}),
          page('/ssr', { classification: 'dynamic' }),
          page('/blog/[slug]', {
            classification: 'dynamic',
            dynamic: true,
            prerender: { paths: ['/blog/hello', '/blog/world/'] },
          }),
          { ...page('/api/data', {}), kind: 'endpoint', id: 'endpoint:/api/data' },
        ],
      }),
    );
    expect([...paths].sort()).toEqual(['/', '/blog/hello', '/blog/world']);
  });
});

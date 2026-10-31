import { createRouteMatcher, emptyManifest } from '@hypdriv/core';
import { toHypRoute } from '@hypdriv/vite';
import { describe, expect, it } from 'vitest';
import {
  type AstroRouteLike,
  type AstroRoutePart,
  astroPattern,
  fromAstroRoutes,
  isHypDrivRoute,
  sourcesFromSsrManifest,
} from './routes';

const lit = (content: string): AstroRoutePart => ({ content, dynamic: false, spread: false });
const param = (content: string): AstroRoutePart => ({ content, dynamic: true, spread: false });
const rest = (content: string): AstroRoutePart => ({ content, dynamic: true, spread: true });

function route(
  pattern: string,
  segments: AstroRoutePart[][],
  extra: Partial<AstroRouteLike> = {},
): AstroRouteLike {
  return { pattern, type: 'page', origin: 'project', isPrerendered: false, segments, ...extra };
}

function matcherFor(routes: AstroRouteLike[]) {
  const manifest = emptyManifest({ routes: fromAstroRoutes(routes).map((r) => toHypRoute(r)) });
  return createRouteMatcher(manifest);
}

describe('astroPattern', () => {
  it('keeps static and single-parameter segments', () => {
    expect(astroPattern(route('/', []))).toEqual({ pathname: '/', regex: '^/(?:/)?$' });
    expect(astroPattern(route('/blog/[slug]', [[lit('blog')], [param('slug')]])).pathname).toBe(
      '/blog/[slug]',
    );
  });

  it('turns rest parameters into optional catch-alls (Astro matches zero segments)', () => {
    const docs = astroPattern(route('/docs/[...path]', [[lit('docs')], [rest('...path')]]));
    expect(docs.pathname).toBe('/docs/[[...path]]');
    const re = new RegExp(docs.regex);
    expect(re.exec('/docs')?.groups?.path).toBeUndefined();
    expect(re.exec('/docs/a/b')?.groups?.path).toBe('a/b');
    expect(astroPattern(route('/[...all]', [[rest('...all')]])).pathname).toBe('/[[...all]]');
  });

  it('builds an exact matcher with named groups for segments that mix text and parameters', () => {
    const feed = astroPattern(route('/feeds/[slug].json', [[lit('feeds')], [param('slug'), lit('.json')]]));
    expect(feed.pathname).toBe('/feeds/[slug].json');
    expect(new RegExp(feed.regex).exec('/feeds/news.json')?.groups).toEqual({ slug: 'news' });
    expect(new RegExp(feed.regex).test('/feeds/news.xml')).toBe(false);
    const version = astroPattern(
      route('/[lang]-[version]/info', [[param('lang'), lit('-'), param('version')], [lit('info')]]),
    );
    expect(new RegExp(version.regex).exec('/en-v2/info')?.groups).toEqual({ lang: 'en', version: 'v2' });
  });
});

describe('fromAstroRoutes', () => {
  const routes: AstroRouteLike[] = [
    route('/_server-islands/[name]', [[lit('_server-islands')], [param('name')]], { origin: 'internal' }),
    route('/_actions/[...path]', [[lit('_actions')], [rest('...path')]], {
      origin: 'internal',
      type: 'endpoint',
    }),
    route('/_hypdriv/[...path]', [[lit('_hypdriv')], [rest('...path')]], {
      origin: 'external',
      type: 'endpoint',
    }),
    route('/old', [[lit('old')]], { type: 'redirect' }),
    route('/', [], { isPrerendered: true, entrypoint: 'src/pages/index.astro' }),
    route('/blog/[slug]', [[lit('blog')], [param('slug')]], { isPrerendered: true }),
    route('/feeds/[slug].json', [[lit('feeds')], [param('slug'), lit('.json')]], { type: 'endpoint' }),
    route('/api/hello', [[lit('api')], [lit('hello')]], { type: 'endpoint' }),
  ];

  it('converts routes, keeps internal ones as endpoints and drops redirects and its own route', () => {
    const out = fromAstroRoutes(routes, { internalPrefix: '/_hypdriv' });
    expect(out.map((r) => [r.pathname, r.kind, r.prerendered ?? false])).toEqual([
      ['/_server-islands/[name]', 'endpoint', false],
      ['/_actions/[[...path]]', 'endpoint', false],
      ['/', 'page', true],
      ['/blog/[slug]', 'page', true],
      ['/feeds/[slug].json', 'endpoint', false],
      ['/api/hello', 'endpoint', false],
    ]);
    expect(out.find((r) => r.pathname === '/')?.sourcePage).toBe('src/pages/index.astro');
    expect(out.find((r) => r.pathname === '/feeds/[slug].json')?.regex).toBeDefined();
    expect(out.find((r) => r.pathname === '/blog/[slug]')?.regex).toBeUndefined();
    expect(isHypDrivRoute({ pattern: '/_hypdriv/[...path]' }, '/_hypdriv/')).toBe(true);
  });

  it('matches requests the way Astro does', () => {
    const matcher = matcherFor(routes);
    expect(matcher.match('/blog/hello')?.route.id).toBe('page:/blog/[slug]');
    expect(matcher.match('/feeds/news.json')).toMatchObject({
      route: { id: 'endpoint:/feeds/[slug].json' },
      params: { slug: 'news' },
    });
    expect(matcher.match('/_actions/echo')?.route.id).toBe('endpoint:/_actions/[[...path]]');
    expect(matcher.match('/_server-islands/Facts')?.route.kind).toBe('endpoint');
  });

  it('attaches client assets of on-demand pages', () => {
    const sources = new Map([['/blog/[slug]', { js: ['/_astro/a.js'], css: [], fonts: [], main: [] }]]);
    const out = fromAstroRoutes(routes, { sources });
    expect(out.find((r) => r.pathname === '/blog/[slug]')?.sources?.js).toEqual(['/_astro/a.js']);
  });
});

describe('sourcesFromSsrManifest', () => {
  it('collects external styles, module scripts and font links per page route', () => {
    const map = sourcesFromSsrManifest(
      [
        {
          routeData: { route: '/ssr', type: 'page' },
          styles: [
            { type: 'inline', content: 'body{}' },
            { type: 'external', src: '/_astro/ssr.css' },
          ],
          scripts: [{ type: 'external', value: '/_astro/hoisted.js' }],
          links: ['/_astro/inter.woff2'],
        },
        { routeData: { route: '/api/x', type: 'endpoint' }, styles: [{ type: 'external', src: '/x.css' }] },
        { routeData: { route: '/plain', type: 'page' }, styles: [{ type: 'inline', content: 'p{}' }] },
      ],
      '/docs/',
    );
    expect([...map.keys()]).toEqual(['/ssr']);
    expect(map.get('/ssr')).toEqual({
      css: ['/_astro/ssr.css'],
      js: ['/_astro/hoisted.js'],
      fonts: ['/_astro/inter.woff2'],
      main: ['/_astro/hoisted.js'],
    });
  });
});

import { compilePattern, loadConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { nextHeaderSource, vercelCdnRouteHeaders } from './cdn-routes';

describe('nextHeaderSource', () => {
  it('translates HypDriv patterns into path-to-regexp sources', () => {
    expect(nextHeaderSource('/')).toBe('/');
    expect(nextHeaderSource('/pricing')).toBe('/pricing');
    expect(nextHeaderSource('/blog/:slug')).toBe('/blog/:slug');
    expect(nextHeaderSource('/docs/:path*')).toBe('/docs/:path*');
    expect(nextHeaderSource('/blog/:slug?')).toBe('/blog/:slug?');
    expect(nextHeaderSource('/api/**')).toBe('/api/:hyp0*');
    expect(nextHeaderSource('/a/**/b')).toBe('/a/:hyp0*/b');
    expect(nextHeaderSource('/files/*.pdf')).toBe('/files/:hyp0([^/]*).pdf');
    expect(nextHeaderSource('/v:version*')).toBe('/v:version(.*)');
    expect(nextHeaderSource('/x:id?')).toBe('/x:id([^/]*)');
    expect(nextHeaderSource('/a**')).toBe('/a:hyp0(.*)');
    expect(nextHeaderSource('/(group)/+plus')).toBe('/\\(group\\)/\\+plus');
  });

  it('refuses what path-to-regexp sources cannot express', () => {
    expect(nextHeaderSource(/^\/regex/)).toBeNull();
    expect(nextHeaderSource('^/raw/(a|b)$')).toBeNull();
    expect(nextHeaderSource('/search\\?*q=*')).toBeNull();
    expect(nextHeaderSource('relative')).toBeNull();
    expect(nextHeaderSource('/a/**.js')).toBeNull();
  });

  it('stays consistent with the HypDriv matcher on literal paths', () => {
    expect(compilePattern('/pricing').regex.test('/pricing')).toBe(true);
    expect(nextHeaderSource('/pricing')).toBe('/pricing');
  });
});

describe('vercelCdnRouteHeaders', () => {
  it('emits rules for expressible origin-overriding policies, first policy last', () => {
    const config = loadConfig({
      cache: {
        edge: {
          policies: [
            {
              id: 'pricing',
              match: '/pricing',
              ttl: '10m',
              swr: '1h',
              tags: ['marketing'],
              respectOrigin: false,
            },
            {
              id: 'blog',
              match: ['/blog', '/blog/:slug'],
              ttl: 60,
              respectOrigin: false,
              includeRsc: false,
              bypass: { query: ['preview'] },
            },
          ],
        },
      },
      vercel: { cdn: { downstream: true } },
    });
    const { rules, skipped } = vercelCdnRouteHeaders(config);
    expect(skipped).toEqual([]);
    expect(rules.map((r) => r.source)).toEqual(['/blog/:slug', '/blog', '/pricing']);
    expect(rules[2]).toEqual({
      source: '/pricing',
      headers: [
        { key: 'vercel-cdn-cache-control', value: 's-maxage=600, stale-while-revalidate=3600' },
        { key: 'cdn-cache-control', value: 's-maxage=600, stale-while-revalidate=3600' },
        { key: 'vercel-cache-tag', value: 'hyp:path:/pricing,marketing' },
      ],
    });
    expect(rules[0]).toEqual({
      source: '/blog/:slug',
      headers: [
        { key: 'vercel-cdn-cache-control', value: 's-maxage=60' },
        { key: 'cdn-cache-control', value: 's-maxage=60' },
      ],
      missing: [
        { type: 'query', key: 'preview' },
        { type: 'header', key: 'rsc' },
      ],
    });
    expect(rules[1]!.headers.find((h) => h.key === 'vercel-cache-tag')?.value).toBe('hyp:path:/blog');
  });

  it('reports policies it cannot express', () => {
    const config = loadConfig({
      cache: {
        edge: {
          policies: [
            { id: 'origin', match: '/a', ttl: 60 },
            { id: 'cookies', match: '/b', ttl: 60, respectOrigin: false, bypass: { cookies: ['session'] } },
            { id: 'vary', match: '/c', ttl: 60, respectOrigin: false, vary: { language: true } },
            { id: 'regex', match: ['/d', /^\/e/], ttl: 60, respectOrigin: false },
            { id: 'zero', match: '/f', ttl: 0, respectOrigin: false },
            { id: 'head', match: '/g', ttl: 60, respectOrigin: false, methods: ['HEAD'] },
          ],
        },
      },
    });
    const { rules, skipped } = vercelCdnRouteHeaders(config);
    expect(rules).toEqual([]);
    expect(skipped).toEqual([
      { policy: 'origin', reason: 'respect-origin' },
      { policy: 'cookies', reason: 'bypass:cookies' },
      { policy: 'vary', reason: 'vary' },
      { policy: 'regex', reason: 'pattern:/^\\/e/' },
      { policy: 'zero', reason: 'zero-ttl' },
      { policy: 'head', reason: 'methods' },
    ]);
  });

  it('returns nothing when the CDN integration or the edge cache is off', () => {
    expect(vercelCdnRouteHeaders(loadConfig({ vercel: { cdn: false } }))).toEqual({ rules: [], skipped: [] });
    expect(vercelCdnRouteHeaders(loadConfig({ cache: { edge: false } }))).toEqual({ rules: [], skipped: [] });
  });
});

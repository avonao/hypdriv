import { describe, expect, it } from 'vitest';
import { hotPaths, hotPathsSql, sanitizeHotPath } from './hot';

describe('hotPathsSql', () => {
  it('ranks pathnames by sample-weighted TTFB rows and over-fetches for the filters', () => {
    const sql = hotPathsSql('shop_vitals', { days: 7, limit: 25 });
    expect(sql).toContain("blob1 = 'TTFB'");
    expect(sql).toContain('SUM(_sample_interval) AS views');
    expect(sql).toContain("INTERVAL '7' DAY");
    expect(sql).toContain('ORDER BY views DESC');
    expect(sql).toContain('LIMIT 75');
  });

  it('clamps the window and the row count and refuses a bad dataset name', () => {
    expect(hotPathsSql('d', { days: 900, limit: 9999 })).toContain("INTERVAL '90' DAY");
    expect(hotPathsSql('d', { days: 900, limit: 9999 })).toContain('LIMIT 1000');
    expect(hotPathsSql('d', { days: 0, limit: 0 })).toContain("INTERVAL '1' DAY");
    expect(() => hotPathsSql('d; DROP', { days: 7, limit: 5 })).toThrow(/dataset/);
  });
});

describe('sanitizeHotPath', () => {
  it('accepts plain absolute paths', () => {
    for (const ok of ['/', '/blog/hello-world', '/docs/a%20b', '/a.b/c_d', '/ünï'])
      expect(sanitizeHotPath(ok)).toBe(ok);
  });

  it('rejects everything that could leave the site or smuggle a request', () => {
    for (const bad of [
      '',
      'blog',
      '//evil.example/x',
      'https://evil.example/',
      '/a\\b',
      '/a b',
      '/a\nb',
      '/a\u0000b',
      '/a?x=1',
      '/a#frag',
      '/a/../b',
      '/a/./b',
      '/_hypdriv/purge',
      '/_hypdriv',
      '/__nextjs_original-stack-frame',
      `/${'x'.repeat(600)}`,
      null,
      undefined,
      42,
    ])
      expect(sanitizeHotPath(bad), String(bad)).toBeNull();
  });
});

describe('hotPaths', () => {
  const rows = [
    { pathname: '/b', views: '90' },
    { pathname: '/a', views: 100 },
    { pathname: '/a', views: 20 },
    { pathname: '/c', views: 19 },
    { pathname: '//evil', views: 5000 },
    { pathname: '/d', views: 'many' },
    { pathname: '/e', views: 40 },
  ];

  it('merges duplicates, drops rejects and thin pages, and ranks busiest first', () => {
    expect(hotPaths(rows, { limit: 10, minViews: 20 })).toEqual([
      { path: '/a', views: 120 },
      { path: '/b', views: 90 },
      { path: '/e', views: 40 },
    ]);
  });

  it('applies the filter before the limit', () => {
    expect(hotPaths(rows, { limit: 2, minViews: 20, accept: (p) => p !== '/a' })).toEqual([
      { path: '/b', views: 90 },
      { path: '/e', views: 40 },
    ]);
    expect(hotPaths(rows, { limit: 0, minViews: 1 })).toEqual([]);
  });
});

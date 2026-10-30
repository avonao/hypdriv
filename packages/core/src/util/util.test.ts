import { describe, expect, it } from 'vitest';
import { base64Decode, base64UrlEncode, hexEncode, stableStringify, timingSafeEqual } from './encoding';
import { bucketPercent, cspHash, cyrb53, hmacSign, hmacVerify, sha256Hex, shortHash } from './hash';
import { createNonce, createRequestId, uuidv7 } from './id';
import { LRUCache } from './lru';
import { compilePattern, firstMatch, matchesAny, matchPattern, patternSpecificity } from './pattern';
import { memoizeAsync, SingleFlight } from './singleflight';
import { formatBytes, formatDuration, parseDuration, parseSize } from './units';

describe('units', () => {
  it('parses durations', () => {
    expect(parseDuration(undefined, 7)).toBe(7);
    expect(parseDuration(30, 0)).toBe(30);
    expect(parseDuration('30s', 0)).toBe(30);
    expect(parseDuration('5m', 0)).toBe(300);
    expect(parseDuration('2h', 0)).toBe(7200);
    expect(parseDuration('1d', 0)).toBe(86400);
    expect(parseDuration('1.5h', 0)).toBe(5400);
    expect(parseDuration('250ms', 0)).toBe(0.25);
    expect(() => parseDuration('soon', 0)).toThrow();
    expect(() => parseDuration(-1, 0)).toThrow();
  });
  it('parses sizes', () => {
    expect(parseSize('250kb', 0)).toBe(250_000);
    expect(parseSize('3mb', 0)).toBe(3_000_000);
    expect(parseSize('1kib', 0)).toBe(1024);
    expect(parseSize(42, 0)).toBe(42);
    expect(() => parseSize('big', 0)).toThrow();
  });
  it('formats', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(12_345)).toBe('12.3 kB');
    expect(formatBytes(3_500_000)).toBe('3.5 MB');
    expect(formatDuration(90)).toBe('1m30s');
    expect(formatDuration(86400 + 3600)).toBe('1d1h');
  });
});

describe('encoding and hashing', () => {
  it('round-trips base64url', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...base64Decode(encoded)]).toEqual([...bytes]);
  });
  it('hashes deterministically', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await cspHash('alert(1)')).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(cyrb53('hello')).toBe(cyrb53('hello'));
    expect(cyrb53('hello')).not.toBe(cyrb53('hellp'));
    expect(shortHash('x')).toMatch(/^[0-9a-z]+$/);
  });
  it('hmac signs and verifies', async () => {
    const sig = await hmacSign('secret', 'payload');
    expect(await hmacVerify('secret', 'payload', sig)).toBe(true);
    expect(await hmacVerify('secret', 'payload2', sig)).toBe(false);
    expect(hexEncode(sig)).toHaveLength(64);
  });
  it('timingSafeEqual compares lengths and bytes', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('buckets uniformly enough', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(bucketPercent(`user-${i}`, 'flag') / 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(800);
    expect(bucketPercent('u1', 'a')).toBe(bucketPercent('u1', 'a'));
  });
  it('stableStringify sorts keys', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });
});

describe('ids', () => {
  it('creates valid UUIDv7 values that sort by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(createRequestId()).toHaveLength(36);
    expect(createNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('pattern matching', () => {
  it('matches exact, params, wildcards', () => {
    expect(matchPattern('/about', '/about').matched).toBe(true);
    expect(matchPattern('/about', '/about/').matched).toBe(true);
    expect(matchPattern('/about', '/about/team').matched).toBe(false);
    expect(matchPattern('/blog/:slug', '/blog/hello')).toEqual({ matched: true, params: { slug: 'hello' } });
    expect(matchPattern('/blog/:slug', '/blog/a/b').matched).toBe(false);
    expect(matchPattern('/docs/:path*', '/docs/a/b/c').params.path).toBe('a/b/c');
    expect(matchPattern('/docs/:path*', '/docs/').matched).toBe(true);
    expect(matchPattern('/files/*.pdf', '/files/report.pdf').matched).toBe(true);
    expect(matchPattern('/files/*.pdf', '/files/a/report.pdf').matched).toBe(false);
    expect(matchPattern('/api/**', '/api').matched).toBe(true);
    expect(matchPattern('/api/**', '/api/v1/users').matched).toBe(true);
    expect(matchPattern('/**/*.bak', '/deep/path/file.bak').matched).toBe(true);
    expect(matchPattern('/**/*.bak', '/file.bak').matched).toBe(true);
    expect(matchPattern('^/re/(a|b)$', '/re/a').matched).toBe(true);
    expect(matchPattern(/^\/rx\/\d+$/, '/rx/42').matched).toBe(true);
    expect(matchPattern('/search\\?*q=*', new URL('https://x.test/search?q=hi')).matched).toBe(true);
    expect(matchPattern('/search\\?*q=*', new URL('https://x.test/search')).matched).toBe(false);
    expect(matchPattern('/*\\?*token=*', new URL('https://x.test/reset?token=abc')).matched).toBe(true);
  });
  it('supports lists and first match', () => {
    expect(matchesAny(['/a', '/b/**'], '/b/c')).toBe(true);
    expect(matchesAny(undefined, '/x')).toBe(false);
    const rules = [
      { match: '/api/**', id: 'api' },
      { match: '/**', id: 'all' },
    ];
    expect(firstMatch(rules, '/api/x')?.id).toBe('api');
    expect(firstMatch(rules, '/home')?.id).toBe('all');
  });
  it('escapes regex characters in literals', () => {
    expect(matchPattern('/a.b', '/axb').matched).toBe(false);
    expect(matchPattern('/a(b)', '/a(b)').matched).toBe(true);
  });
  it('caches compiled patterns', () => {
    expect(compilePattern('/x/**')).toBe(compilePattern('/x/**'));
  });
  it('ranks specificity', () => {
    expect(patternSpecificity('/blog/post')).toBeGreaterThan(patternSpecificity('/blog/:slug'));
    expect(patternSpecificity('/blog/:slug')).toBeGreaterThan(patternSpecificity('/blog/**'));
  });
});

describe('LRUCache', () => {
  it('evicts least recently used and honours TTL', () => {
    let t = 0;
    const lru = new LRUCache<string, number>(2, 100, () => t);
    lru.set('a', 1).set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    expect(lru.has('b')).toBe(false);
    expect(lru.get('a')).toBe(1);
    t = 150;
    expect(lru.get('a')).toBeUndefined();
    expect(() => new LRUCache(0)).toThrow();
  });
});

describe('SingleFlight', () => {
  it('shares in-flight work and clears afterwards', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };
    const a = sf.run('k', fn);
    const b = sf.run('k', fn);
    expect(a.shared).toBe(false);
    expect(b.shared).toBe(true);
    expect(await Promise.all([a.promise, b.promise])).toEqual([42, 42]);
    expect(calls).toBe(1);
    expect(sf.size).toBe(0);
  });
  it('memoizes with TTL', async () => {
    let t = 0;
    let calls = 0;
    const m = memoizeAsync(
      async () => ++calls,
      100,
      () => t,
    );
    expect(await m.get('x')).toBe(1);
    expect(await m.get('x')).toBe(1);
    t = 200;
    expect(await m.get('x')).toBe(2);
    m.invalidate();
    expect(await m.get('x')).toBe(3);
  });
});

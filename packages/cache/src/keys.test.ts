import { DEFAULT_TRACKING_PARAMS, type EdgeCachePolicy, resolveEdgeCachePolicy } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { buildCacheKey, CACHE_KEY_ORIGIN, cacheKeyUrl, serializeCacheKey } from './keys';
import type { CacheKeyInput } from './types';

function policy(partial: Partial<EdgeCachePolicy> = {}) {
  return resolveEdgeCachePolicy({ match: '/**', ttl: 60, ...partial }, 0);
}

function input(url: string, init: RequestInit = {}, partial: Partial<CacheKeyInput> = {}): CacheKeyInput {
  const request = new Request(url, init);
  return {
    request,
    url: new URL(request.url),
    policy: policy(),
    buildId: 'b1',
    trailingSlash: false,
    ignoredQuery: DEFAULT_TRACKING_PARAMS,
    ...partial,
  };
}

const key = (i: CacheKeyInput) => buildCacheKey(i).then((r) => r.key);

describe('buildCacheKey', () => {
  it('is deterministic and returns a base64url hash plus a synthetic URL', async () => {
    const a = await buildCacheKey(input('https://Example.com/blog?b=2&a=1'));
    const b = await buildCacheKey(input('https://example.com/blog?a=1&b=2'));
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.url).toBe(`${CACHE_KEY_ORIGIN}/${a.key}`);
    expect(cacheKeyUrl('k', 'https://x.test/')).toBe('https://x.test/k');
  });

  it('keys HEAD like GET and distinguishes other methods', async () => {
    const get = await key(input('https://x.test/p'));
    const head = await key(input('https://x.test/p', { method: 'HEAD' }));
    expect(head).toBe(get);
  });

  it('normalises host case, default ports and duplicate slashes', async () => {
    const a = await key(input('https://X.TEST:443//docs//intro'));
    const b = await key(input('https://x.test/docs/intro'));
    expect(a).toBe(b);
  });

  it('keeps /page and /page/ apart whatever the trailingSlash setting says', async () => {
    // With Next's trailingSlash one of the two is a redirect to the other: a shared entry would serve the redirect
    // for the page, and the page for the redirect (or loop).
    for (const setting of [null, false, true]) {
      const bare = await key(input('https://x.test/docs/intro', {}, { trailingSlash: setting }));
      const slash = await key(input('https://x.test/docs/intro/', {}, { trailingSlash: setting }));
      expect(slash).not.toBe(bare);
    }
    expect(await key(input('https://x.test/docs/intro', {}, { trailingSlash: true }))).toBe(
      await key(input('https://x.test/docs/intro', {}, { trailingSlash: false })),
    );
  });

  it('drops ignored (tracking) parameters and sorts the rest', async () => {
    const clean = await key(input('https://x.test/p?z=1&a=2'));
    expect(await key(input('https://x.test/p?a=2&utm_source=tw&fbclid=abc&z=1'))).toBe(clean);
    expect(await key(input('https://x.test/p?a=3&z=1'))).not.toBe(clean);
    const custom = await key(input('https://x.test/p?a=2&z=1&foo=1', {}, { ignoredQuery: ['foo'] }));
    expect(custom).toBe(await key(input('https://x.test/p?a=2&z=1', {}, { ignoredQuery: ['foo'] })));
  });

  it("honours keyQuery 'none' and allow-lists", async () => {
    const none = policy({ keyQuery: 'none' });
    expect(await key(input('https://x.test/p?a=1', {}, { policy: none }))).toBe(
      await key(input('https://x.test/p?b=2', {}, { policy: none })),
    );
    const only = policy({ keyQuery: ['page'] });
    expect(await key(input('https://x.test/p?page=2&sort=asc', {}, { policy: only }))).toBe(
      await key(input('https://x.test/p?page=2', {}, { policy: only })),
    );
    expect(await key(input('https://x.test/p?page=3', {}, { policy: only }))).not.toBe(
      await key(input('https://x.test/p?page=2', {}, { policy: only })),
    );
  });

  it('includes the build id', async () => {
    expect(await key(input('https://x.test/p'))).not.toBe(
      await key(input('https://x.test/p', {}, { buildId: 'b2' })),
    );
  });

  it('varies on listed headers with lowercased values, independent of list order', async () => {
    const p1 = policy({ vary: { headers: ['Accept-Language', 'X-Theme'] } });
    const p2 = policy({ vary: { headers: ['x-theme', 'accept-language'] } });
    const h = { 'accept-language': 'EN-us', 'x-theme': 'Dark' };
    const a = await buildCacheKey(input('https://x.test/p', { headers: h }, { policy: p1 }));
    const b = await buildCacheKey(
      input(
        'https://x.test/p',
        { headers: { 'accept-language': 'en-US', 'x-theme': 'dark' } },
        { policy: p2 },
      ),
    );
    expect(a.key).toBe(b.key);
    expect(a.vary).toEqual(['accept-language', 'x-theme']);
    const c = await key(input('https://x.test/p', { headers: { 'accept-language': 'de' } }, { policy: p1 }));
    expect(c).not.toBe(a.key);
    // Unvaried headers do not matter.
    expect(await key(input('https://x.test/p', { headers: { 'x-other': '1' } }))).toBe(
      await key(input('https://x.test/p')),
    );
  });

  it('varies on listed cookies only', async () => {
    const p = policy({ vary: { cookies: ['theme'] } });
    const dark = await buildCacheKey(
      input('https://x.test/p', { headers: { cookie: 'theme=dark; session=abc' } }, { policy: p }),
    );
    const dark2 = await key(
      input('https://x.test/p', { headers: { cookie: 'session=zzz; theme=dark' } }, { policy: p }),
    );
    const light = await key(input('https://x.test/p', { headers: { cookie: 'theme=light' } }, { policy: p }));
    expect(dark.key).toBe(dark2);
    expect(dark.key).not.toBe(light);
    expect(dark.vary).toEqual(['cookie']);
  });

  it('varies on geo fields, flags, locale and device', async () => {
    const p = policy({ vary: { geo: ['country'], flags: ['beta'], language: true, device: true } });
    const base = input(
      'https://x.test/p',
      {},
      {
        policy: p,
        geo: { country: 'US', city: 'NYC' },
        flags: { beta: true, other: 1 },
        locale: 'en',
        device: 'desktop',
      },
    );
    const k = await buildCacheKey(base);
    // Flag values come from the visitor's cookies, so a shared cache in front of the Worker must vary on them.
    expect(k.vary).toEqual(['accept-language', 'cookie', 'sec-ch-ua-mobile']);
    // Unlisted geo field and flag do not fragment.
    expect(await key({ ...base, geo: { country: 'US', city: 'SF' }, flags: { beta: true, other: 2 } })).toBe(
      k.key,
    );
    expect(await key({ ...base, geo: { country: 'DE' } })).not.toBe(k.key);
    expect(await key({ ...base, flags: { beta: false } })).not.toBe(k.key);
    expect(await key({ ...base, locale: 'de' })).not.toBe(k.key);
    expect(await key({ ...base, device: 'mobile' })).not.toBe(k.key);
    const material = serializeCacheKey(base).material;
    expect(material).toContain('g country=US');
    expect(material).toContain('f beta=true');
    expect(material).toContain('l en');
    expect(material).toContain('d desktop');
    expect(material).toContain('b b1');
  });

  it('keys RSC payload requests separately, including router state and prefetch markers', async () => {
    const html = await key(input('https://x.test/p'));
    const rsc = await buildCacheKey(
      input('https://x.test/p', { headers: { rsc: '1', 'next-router-state-tree': 'tree-a' } }),
    );
    const rscOther = await key(
      input('https://x.test/p', { headers: { rsc: '1', 'next-router-state-tree': 'tree-b' } }),
    );
    const prefetch = await key(
      input('https://x.test/p', {
        headers: { rsc: '1', 'next-router-state-tree': 'tree-a', 'next-router-prefetch': '1' },
      }),
    );
    expect(rsc.key).not.toBe(html);
    expect(rscOther).not.toBe(rsc.key);
    expect(prefetch).not.toBe(rsc.key);
    expect(rsc.vary).toEqual(['next-router-prefetch', 'next-router-state-tree', 'next-url', 'rsc']);
  });
});

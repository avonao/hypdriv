import type { CacheLike } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheKeyUrl } from './keys';
import { createCacheApiStore } from './stores/cache-api';
import { decodeMeta, META_HEADER } from './stores/meta';
import type { CacheEntry, CacheMeta } from './types';

const NOW = Date.now();

/** `caches.default` is Workers-only; the DOM lib typings do not know it. */
const defaultCache = () => (globalThis as unknown as { caches: { default: CacheLike } }).caches.default;
const keys: string[] = [];

function meta(key: string, partial: Partial<CacheMeta> = {}): CacheMeta {
  keys.push(key);
  return {
    key,
    storedAt: NOW,
    ttl: 60,
    swr: 120,
    staleIfError: 300,
    tags: ['route:app:/x', 'build:b1'],
    buildId: 'b1',
    policyId: 'p',
    vary: [],
    status: 200,
    ...partial,
  };
}

function entry(
  key: string,
  body: string | null,
  init: ResponseInit = {},
  m: Partial<CacheMeta> = {},
): CacheEntry {
  return { response: new Response(body, init), meta: meta(key, m) };
}

afterEach(async () => {
  for (const key of keys.splice(0, keys.length)) await defaultCache().delete(cacheKeyUrl(key));
});

describe('cache-api store inside workerd', () => {
  it('round-trips put / match / delete with metadata and restored origin headers', async () => {
    const store = createCacheApiStore();
    const key = `w-${crypto.randomUUID()}`;
    await store.set(
      key,
      entry(key, '<html>hi</html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 's-maxage=31536000, stale-while-revalidate',
          'set-cookie': 'leak=1',
          'x-hypdriv-cache': 'MISS',
        },
      }),
    );

    const raw = await defaultCache().match(cacheKeyUrl(key));
    expect(raw).toBeDefined();
    expect(raw!.headers.get('cache-control')).toBe('public, s-maxage=480');
    expect(raw!.headers.get('set-cookie')).toBeNull();
    expect(decodeMeta(raw!.headers.get(META_HEADER))?.tags).toEqual(['route:app:/x', 'build:b1']);
    await raw!.body?.cancel();

    const hit = await store.get(key);
    expect(hit).not.toBeNull();
    expect(await hit!.response.text()).toBe('<html>hi</html>');
    expect(hit!.response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(hit!.response.headers.get('cache-control')).toBe('s-maxage=31536000, stale-while-revalidate');
    expect(hit!.response.headers.get(META_HEADER)).toBeNull();
    expect(hit!.response.headers.get('x-hypdriv-cache')).toBeNull();
    expect(hit!.meta).toMatchObject({ key, ttl: 60, swr: 120, staleIfError: 300, status: 200 });

    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it('stores negative entries and bodiless statuses', async () => {
    const store = createCacheApiStore();
    const nf = `w-${crypto.randomUUID()}`;
    await store.set(
      nf,
      entry(nf, 'not found', { status: 404 }, { status: 404, ttl: 60, swr: 0, staleIfError: 0 }),
    );
    const hit = await store.get(nf);
    expect(hit?.response.status).toBe(404);
    expect(await hit!.response.text()).toBe('not found');

    const redirect = `w-${crypto.randomUUID()}`;
    await store.set(
      redirect,
      entry(redirect, null, { status: 308, headers: { location: '/new' } }, { status: 308 }),
    );
    const r = await store.get(redirect);
    expect(r?.response.status).toBe(308);
    expect(r?.response.headers.get('location')).toBe('/new');
  });

  it('ignores entries without HypDriv metadata and uses named caches on request', async () => {
    const key = `w-${crypto.randomUUID()}`;
    keys.push(key);
    await defaultCache().put(
      cacheKeyUrl(key),
      new Response('foreign', { headers: { 'cache-control': 's-maxage=60' } }),
    );
    expect(await createCacheApiStore().get(key)).toBeNull();

    const named = createCacheApiStore({ cacheName: 'hypdriv-test' });
    expect(named.name).toBe('cache-api:hypdriv-test');
    await named.set(key, entry(key, 'named'));
    expect(await named.get(key).then((e) => e!.response.text())).toBe('named');
    await named.delete(key);
    expect(await named.get(key)).toBeNull();
  });
});

import { type Capabilities, resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { fakeCache, fakeKv } from '../__fixtures__/fakes';
import { cacheKeyUrl } from '../keys';
import type { CacheEntry, CacheMeta, CacheStore } from '../types';
import { createCacheApiStore } from './cache-api';
import { createKvStore, decodeKvValue, encodeKvValue } from './kv';
import { createMemoryStore } from './memory';
import { decodeMeta, entryFreshness, META_HEADER, readBody, storableHeaders } from './meta';
import { selectStore } from './select';
import { createTieredStore } from './tiered';

const NOW = 1_700_000_000_000;

function meta(partial: Partial<CacheMeta> = {}): CacheMeta {
  return {
    key: 'k1',
    storedAt: NOW,
    ttl: 60,
    swr: 120,
    staleIfError: 300,
    tags: ['route:app:/x', 'build:b1'],
    buildId: 'b1',
    policyId: 'p',
    vary: ['accept-language'],
    status: 200,
    ...partial,
  };
}

function entry(
  body: string | null = 'hello',
  init: ResponseInit = {},
  m: Partial<CacheMeta> = {},
): CacheEntry {
  const headers = new Headers({
    'content-type': 'text/html',
    ...(init.headers as Record<string, string> | undefined),
  });
  return { response: new Response(body, { ...init, headers }), meta: meta(m) };
}

async function roundTrip(store: CacheStore) {
  await store.set(
    'k1',
    entry('hello', {
      headers: { 'cache-control': 's-maxage=5', 'set-cookie': 'a=b', 'x-hypdriv-cache': 'MISS', age: '9' },
    }),
  );
  const hit = await store.get('k1');
  expect(hit).not.toBeNull();
  expect(await hit!.response.text()).toBe('hello');
  expect(hit!.response.status).toBe(200);
  expect(hit!.response.headers.get('content-type')).toBe('text/html');
  expect(hit!.response.headers.get('cache-control')).toBe('s-maxage=5');
  expect(hit!.response.headers.get('set-cookie')).toBeNull();
  expect(hit!.response.headers.get('x-hypdriv-cache')).toBeNull();
  expect(hit!.response.headers.get('age')).toBeNull();
  expect(hit!.meta).toEqual(meta());
  // Reading twice works (bodies are not consumed by the store).
  const again = await store.get('k1');
  expect(await again!.response.text()).toBe('hello');
  await store.delete('k1');
  expect(await store.get('k1')).toBeNull();
  expect(await store.get('missing')).toBeNull();
}

describe('meta helpers', () => {
  it('classifies freshness', () => {
    const m = meta();
    expect(entryFreshness(m, NOW + 59_000)).toMatchObject({ state: 'fresh' });
    expect(entryFreshness(m, NOW + 60_000)).toMatchObject({ state: 'stale', age: 60 });
    expect(entryFreshness(m, NOW + 179_999)).toMatchObject({ state: 'stale' });
    expect(entryFreshness(m, NOW + 180_000)).toMatchObject({ state: 'error' });
    expect(entryFreshness(m, NOW + 480_000)).toMatchObject({ state: 'expired', age: 480 });
    expect(entryFreshness(m, NOW - 5000).age).toBe(0);
  });
  it('decodes meta defensively', () => {
    expect(decodeMeta(null)).toBeNull();
    expect(decodeMeta('{')).toBeNull();
    expect(decodeMeta('{"key":"k"}')).toBeNull();
    expect(
      decodeMeta(JSON.stringify({ key: 'k', storedAt: 1, ttl: 2, status: 200, tags: ['a', 3] })),
    ).toEqual({
      key: 'k',
      storedAt: 1,
      ttl: 2,
      swr: 0,
      staleIfError: 0,
      tags: ['a'],
      buildId: '',
      policyId: '',
      vary: [],
      status: 200,
    });
  });
  it('strips volatile headers and caps body reads', async () => {
    const h = storableHeaders(
      new Headers({ 'set-cookie': 'a=1', 'cache-tag': 't', 'content-type': 'x', [META_HEADER]: '{}' }),
    );
    expect([...h.keys()]).toEqual(['content-type']);
    const big = new Response('x'.repeat(100)).body!;
    expect(await readBody(big, 10)).toBeNull();
    const ok = await readBody(new Response('abc').body, 10);
    expect(new TextDecoder().decode(ok!)).toBe('abc');
    expect((await readBody(null, 10))!.byteLength).toBe(0);
  });
});

describe('memory store', () => {
  it('round-trips entries', async () => {
    await roundTrip(createMemoryStore({ now: () => NOW }));
  });

  it('evicts by entry count (LRU) and by bytes, and expires dead entries', async () => {
    let now = NOW;
    const store = createMemoryStore({ maxEntries: 2, now: () => now });
    await store.set('a', entry('a'));
    await store.set('b', entry('b'));
    await store.get('a'); // a becomes most recent
    await store.set('c', entry('c'));
    expect(store.size).toBe(2);
    expect(await store.get('b')).toBeNull();
    expect(await store.get('a')).not.toBeNull();

    const small = createMemoryStore({ maxBytes: 2000, now: () => now });
    await small.set('x', entry('x'.repeat(1000)));
    await small.set('y', entry('y'.repeat(1000)));
    expect(small.size).toBe(1);
    expect(await small.get('y')).not.toBeNull();
    expect(small.bytes).toBeLessThanOrEqual(2000);

    now = NOW + 481_000; // beyond ttl + swr + staleIfError
    expect(await small.get('y')).toBeNull();
    expect(small.size).toBe(0);
  });

  it('handles null bodies and null-body statuses', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await store.set('n', entry(null, { status: 204 }, { status: 204 }));
    const hit = await store.get('n');
    expect(hit?.response.status).toBe(204);
    expect(hit?.response.body).toBeNull();
  });

  it('skips entries without lifetime', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await store.set('z', entry('z', {}, { ttl: 0, swr: 0, staleIfError: 0 }));
    expect(store.size).toBe(0);
  });
});

describe('cache-api store', () => {
  it('round-trips entries through a Cache implementation', async () => {
    const cache = fakeCache();
    await roundTrip(createCacheApiStore({ cache }));
  });

  it('stores meta in a header with an s-maxage covering the whole lifetime and restores origin headers', async () => {
    const cache = fakeCache();
    const store = createCacheApiStore({ cache, keyOrigin: 'https://keys.test' });
    await store.set(
      'k1',
      entry('body', {
        headers: { 'cache-control': 'max-age=30', expires: 'Thu, 01 Jan 2099 00:00:00 GMT', vary: '*' },
      }),
    );
    const raw = cache.entries.get(cacheKeyUrl('k1', 'https://keys.test'))!;
    expect(raw.headers.get('cache-control')).toBe('public, s-maxage=480');
    expect(raw.headers.get('expires')).toBeNull();
    expect(raw.headers.get('vary')).toBeNull();
    expect(decodeMeta(raw.headers.get(META_HEADER))).toEqual(meta());
    const hit = await store.get('k1');
    expect(hit?.response.headers.get('cache-control')).toBe('max-age=30');
    expect(hit?.response.headers.get('expires')).toBe('Thu, 01 Jan 2099 00:00:00 GMT');
    expect(hit?.response.headers.get(META_HEADER)).toBeNull();
  });

  it('ignores foreign entries and resolves caches.default lazily', async () => {
    const cache = fakeCache();
    cache.entries.set(cacheKeyUrl('foreign'), new Response('x'));
    const store = createCacheApiStore({ cache });
    expect(await store.get('foreign')).toBeNull();
    const none = createCacheApiStore({ cache: Promise.resolve(cache) });
    expect(await none.get('missing')).toBeNull();
  });
});

describe('kv store', () => {
  it('round-trips framed values', async () => {
    const kv = fakeKv(() => NOW);
    await roundTrip(createKvStore(kv, { now: () => NOW }));
  });

  it('frames the envelope, applies the 60 s KV minimum and a size cap', async () => {
    const kv = fakeKv(() => NOW);
    const store = createKvStore(kv, { prefix: 'p:', maxBytes: 100, now: () => NOW });
    await store.set('k1', entry('short', {}, { ttl: 5, swr: 0, staleIfError: 0 }));
    expect(kv.puts[0]).toMatchObject({ key: 'p:k1', options: { expirationTtl: 60 } });
    expect((kv.puts[0]!.options!.metadata as { status: number }).status).toBe(200);
    await store.set('k2', entry('x'.repeat(200)));
    expect(kv.data.has('p:k2')).toBe(false);
    const frame = decodeKvValue(
      encodeKvValue(
        { meta: meta(), status: 200, statusText: 'OK', headers: [['a', 'b']] },
        new TextEncoder().encode('hi').buffer as ArrayBuffer,
      ),
    );
    expect(frame?.envelope.headers).toEqual([['a', 'b']]);
    expect(new TextDecoder().decode(frame!.body)).toBe('hi');
    expect(decodeKvValue(new ArrayBuffer(3))).toBeNull();
    expect(decodeKvValue(new TextEncoder().encode('garbage!!').buffer as ArrayBuffer)).toBeNull();
  });

  it('treats entries past their lifetime as misses even when KV kept them', async () => {
    let now = NOW;
    const kv = fakeKv(() => now);
    const store = createKvStore(kv, { now: () => now });
    await store.set('k1', entry('v', {}, { ttl: 1, swr: 0, staleIfError: 0 }));
    expect(await store.get('k1')).not.toBeNull();
    now = NOW + 2000;
    expect(await store.get('k1')).toBeNull();
  });
});

describe('tiered store', () => {
  it('reads through, backfills upper tiers and writes through', async () => {
    const memory = createMemoryStore({ now: () => NOW });
    const cache = fakeCache();
    const api = createCacheApiStore({ cache });
    const kv = fakeKv(() => NOW);
    const kvStore = createKvStore(kv, { now: () => NOW });
    const tiered = createTieredStore([memory, api, kvStore]);
    expect(tiered.name).toBe('tiered(memory,cache-api,kv)');

    await tiered.set('k1', entry('one'));
    expect(memory.size).toBe(1);
    expect(cache.entries.size).toBe(1);
    expect(kv.data.size).toBe(1);

    // Lower-tier hit backfills the tiers above it.
    await kvStore.set('k2', entry('two'));
    const hit = await tiered.get('k2');
    expect(await hit!.response.text()).toBe('two');
    expect(memory.size).toBe(2);
    expect(cache.entries.size).toBe(2);
    expect(await memory.get('k2').then((e) => e!.response.text())).toBe('two');

    await tiered.delete('k1');
    expect(memory.size).toBe(1);
    expect(cache.entries.size).toBe(1);
    expect(kv.data.size).toBe(1);
    expect(await tiered.get('k1')).toBeNull();
  });

  it('tolerates a failing tier on reads and only throws when every tier fails a write', async () => {
    const broken: CacheStore = {
      name: 'broken',
      get: async () => {
        throw new Error('down');
      },
      set: async () => {
        throw new Error('down');
      },
      delete: async () => {
        throw new Error('down');
      },
    };
    const memory = createMemoryStore({ now: () => NOW });
    const tiered = createTieredStore([broken, memory]);
    await tiered.set('k1', entry('x'));
    expect(await tiered.get('k1').then((e) => e!.response.text())).toBe('x');
    await expect(createTieredStore([broken, broken]).set('k', entry('x'))).rejects.toThrow('down');
    expect(createTieredStore([memory])).toBe(memory);
    expect(() => createTieredStore([])).toThrow(RangeError);
  });
});

describe('selectStore', () => {
  const config = resolveConfig({});
  const caps = (partial: Partial<Capabilities>): Capabilities => ({
    cacheApi: false,
    kv: false,
    tagIndex: false,
    limiter: false,
    channel: false,
    rateLimitBinding: false,
    analyticsEngine: false,
    images: false,
    assets: false,
    queues: [],
    ai: false,
    waitUntil: true,
    cf: false,
    htmlRewriter: false,
    asyncLocalStorage: false,
    ...partial,
  });
  const kv = fakeKv();

  it('picks the richest available store for auto', () => {
    expect(selectStore('auto', caps({}), {}, config).name).toBe('memory');
    expect(selectStore('auto', caps({ cacheApi: true }), {}, config).name).toBe('cache-api');
    expect(selectStore('auto', caps({ cacheApi: true, kv: true }), { HYPDRIV_KV: kv }, config).name).toBe(
      'tiered(memory,cache-api,kv)',
    );
    expect(selectStore('auto', caps({ kv: true }), { HYPDRIV_KV: kv }, config).name).toBe(
      'tiered(memory,kv)',
    );
  });

  it('honours explicit kinds and degrades when the capability is missing', () => {
    expect(selectStore('memory', caps({ cacheApi: true, kv: true }), { HYPDRIV_KV: kv }, config).name).toBe(
      'memory',
    );
    expect(selectStore('cache-api', caps({ cacheApi: true }), {}, config).name).toBe('cache-api');
    expect(selectStore('cache-api', caps({}), {}, config).name).toBe('memory');
    expect(selectStore('kv', caps({ kv: true }), { HYPDRIV_KV: kv }, config).name).toBe('kv');
    expect(selectStore('kv', caps({ cacheApi: true }), {}, config).name).toBe('cache-api');
    expect(selectStore('tiered', caps({}), {}, config).name).toBe('memory');
    expect(selectStore('tiered', caps({ cacheApi: true }), {}, config).name).toBe('tiered(memory,cache-api)');
    const custom = resolveConfig({ cloudflare: { bindings: { kv: 'MY_KV' } } });
    expect(selectStore('kv', caps({ kv: true }), { MY_KV: kv }, custom).name).toBe('kv');
  });
});

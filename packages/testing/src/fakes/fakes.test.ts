import { describe, expect, it } from 'vitest';
import { createClock } from '../clock';
import { createFakeCache } from './cache';
import { createFakeDurableObjectNamespace, fakeIdFromName } from './durable-object';
import { createFakeKV } from './kv';
import {
  createFakeAnalyticsEngine,
  createFakeExecutionContext,
  createFakeQueue,
  createFakeRateLimitBinding,
} from './misc';

describe('createClock', () => {
  it('only moves when told to', () => {
    const clock = createClock(1_000_000);
    expect(clock.now()).toBe(1_000_000);
    clock.advance(1500);
    expect(clock.now()).toBe(1_001_500);
    expect(clock.nowSeconds()).toBe(1001);
    clock.tick(2);
    expect(clock.now()).toBe(1_003_500);
    clock.set(5);
    expect(clock.now()).toBe(5);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });
});

describe('createFakeKV', () => {
  it('stores text, json, arrayBuffer and streams with metadata', async () => {
    const kv = createFakeKV();
    await kv.put('a', 'hello', { metadata: { v: 1 } });
    await kv.put('b', JSON.stringify({ x: 1 }));
    await kv.put('c', new Uint8Array([1, 2, 3]));
    await kv.put('d', new Response('streamed').body!);
    expect(await kv.get('a')).toBe('hello');
    expect(await kv.get('b', 'json')).toEqual({ x: 1 });
    expect(new Uint8Array((await kv.get('c', 'arrayBuffer'))!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await new Response((await kv.get('d', { type: 'stream' }))!).text()).toBe('streamed');
    expect(await kv.getWithMetadata('a')).toEqual({ value: 'hello', metadata: { v: 1 } });
    expect(await kv.getWithMetadata('zzz')).toEqual({ value: null, metadata: null });
    expect(await kv.get('missing')).toBeNull();
    expect(kv.size).toBe(4);
    expect(kv.reads).toBe(7);
    expect(kv.writes).toBe(4);
    expect(kv.dump()).toMatchObject({ a: 'hello' });
    await kv.delete('a');
    expect(await kv.get('a')).toBeNull();
  });

  it('expires with expirationTtl and absolute expiration on the clock', async () => {
    const clock = createClock(Date.UTC(2026, 0, 1));
    const kv = createFakeKV({ clock });
    await kv.put('ttl', 'x', { expirationTtl: 60 });
    await kv.put('abs', 'y', { expiration: clock.nowSeconds() + 10 });
    await kv.put('forever', 'z');
    clock.tick(59);
    expect(await kv.get('ttl')).toBe('x');
    expect(await kv.get('abs')).toBeNull();
    clock.tick(1);
    expect(await kv.get('ttl')).toBeNull();
    expect(await kv.get('forever')).toBe('z');
    expect(kv.size).toBe(1);
    await expect(kv.put('bad', 'x', { expirationTtl: 0 })).rejects.toThrow();
  });

  it('lists with prefix, limit, cursor, metadata and expiration', async () => {
    const clock = createClock();
    const kv = createFakeKV({ clock, initial: { 'z:last': '1' } });
    for (let i = 0; i < 5; i++) await kv.put(`k:${i}`, String(i), { metadata: { i }, expirationTtl: 100 });
    await kv.put('k:expired', 'gone', { expirationTtl: 1 });
    clock.tick(2);
    const page1 = await kv.list({ prefix: 'k:', limit: 2 });
    expect(page1.keys.map((k) => k.name)).toEqual(['k:0', 'k:1']);
    expect(page1.keys[0]).toMatchObject({ metadata: { i: 0 }, expiration: clock.nowSeconds() - 2 + 100 });
    expect(page1.list_complete).toBe(false);
    const page2 = await kv.list({ prefix: 'k:', limit: 2, cursor: page1.cursor });
    expect(page2.keys.map((k) => k.name)).toEqual(['k:2', 'k:3']);
    const page3 = await kv.list({ prefix: 'k:', limit: 2, cursor: page2.cursor });
    expect(page3.keys.map((k) => k.name)).toEqual(['k:4']);
    expect(page3.list_complete).toBe(true);
    expect(page3.cursor).toBeUndefined();
    const all = await kv.list();
    expect(all.keys.map((k) => k.name)).toEqual(['k:0', 'k:1', 'k:2', 'k:3', 'k:4', 'z:last']);
  });
});

describe('createFakeCache', () => {
  const url = 'https://example.com/page?x=1#frag';

  it('stores GET responses, serves them with Age and expires on the clock', async () => {
    const clock = createClock();
    const cache = createFakeCache({ clock });
    expect(await cache.match(url)).toBeUndefined();
    await cache.put(
      url,
      new Response('body', { headers: { 'cache-control': 'public, max-age=10, s-maxage=30', 'x-a': '1' } }),
    );
    expect(cache.keys()).toEqual(['GET https://example.com/page?x=1']);
    clock.tick(5);
    const hit = await cache.match(new Request('https://example.com/page?x=1'));
    expect(hit?.status).toBe(200);
    expect(await hit?.text()).toBe('body');
    expect(hit?.headers.get('age')).toBe('5');
    expect(hit?.headers.get('cf-cache-status')).toBe('HIT');
    expect(hit?.headers.get('x-a')).toBe('1');
    clock.tick(25);
    expect(await cache.match(url)).toBeUndefined();
    expect(cache.stats).toEqual({ hits: 1, misses: 2, puts: 1, rejected: 0 });
  });

  it('honours Expires when no max-age, keeps unbounded entries, and matches ignoring method', async () => {
    const clock = createClock();
    const cache = createFakeCache({ clock });
    await cache.put(
      url,
      new Response('exp', { headers: { expires: new Date(clock.now() + 2000).toUTCString() } }),
    );
    await cache.put('https://example.com/forever', new Response('forever'));
    clock.tick(1);
    expect(await (await cache.match(url))?.text()).toBe('exp');
    clock.tick(2);
    expect(await cache.match(url)).toBeUndefined();
    expect(await cache.match('https://example.com/forever')).toBeDefined();
    const post = new Request('https://example.com/forever', { method: 'POST' });
    expect(await cache.match(post)).toBeUndefined();
    expect(await (await cache.match(post, { ignoreMethod: true }))?.text()).toBe('forever');
    expect(await cache.delete('https://example.com/forever')).toBe(true);
    expect(await cache.delete('https://example.com/forever')).toBe(false);
  });

  it('rejects uncacheable responses like the Workers Cache API', async () => {
    const cache = createFakeCache();
    const uncacheable: Record<string, string>[] = [
      { 'cache-control': 'no-store' },
      { 'cache-control': 'private, max-age=60' },
      { 'cache-control': 'max-age=0' },
      { vary: '*' },
      { 'set-cookie': 'a=b' },
    ];
    for (const headers of uncacheable) {
      await cache.put('https://example.com/x', new Response('x', { headers }));
    }
    expect(cache.size).toBe(0);
    expect(cache.stats.rejected).toBe(5);
    await expect(
      cache.put(new Request('https://example.com/x', { method: 'POST' }), new Response('x')),
    ).rejects.toThrow(/non-GET/);
    await expect(cache.put('https://example.com/x', new Response('x', { status: 206 }))).rejects.toThrow(
      /206/,
    );
  });
});

describe('createFakeDurableObjectNamespace', () => {
  it('hashes names deterministically and memoises instances per id', async () => {
    let created = 0;
    const ns = createFakeDurableObjectNamespace((id) => {
      created++;
      let count = 0;
      return {
        async fetch(request: Request) {
          count++;
          return Response.json({
            id: id.toString(),
            name: id.name,
            count,
            path: new URL(request.url).pathname,
          });
        },
        increment(by = 1) {
          count += by;
          return count;
        },
      };
    });
    const id = ns.idFromName('room-1');
    expect(id.toString()).toBe(fakeIdFromName('room-1'));
    expect(id.toString()).toMatch(/^[0-9a-f]{64}$/);
    expect(ns.idFromName('room-1').equals(id)).toBe(true);
    expect(ns.idFromName('room-2').equals(id)).toBe(false);

    const stub = ns.get(id);
    expect(ns.get(ns.idFromName('room-1'))).toBe(stub);
    const first = (await (await stub.fetch('/a')).json()) as { count: number; path: string; name: string };
    const second = (await (
      await ns.get(ns.idFromName('room-1')).fetch('https://x.test/b', { method: 'POST' })
    ).json()) as { count: number; path: string };
    expect(first).toMatchObject({ count: 1, path: '/a', name: 'room-1' });
    expect(second).toMatchObject({ count: 2, path: '/b' });
    expect(created).toBe(1);
    expect(await (stub as unknown as { increment(by: number): Promise<number> }).increment(5)).toBe(7);
    expect(ns.fetches.map((f) => f.request.method)).toEqual(['GET', 'POST']);
    expect(ns.instances().size).toBe(1);

    await ns.get(ns.idFromName('room-2')).fetch('/x');
    expect(created).toBe(2);
    expect(ns.idFromString(id.toString()).toString()).toBe(id.toString());
    expect(() => ns.idFromString('nope')).toThrow();
    expect(ns.newUniqueId().toString()).toMatch(/^[0-9a-f]{64}$/);
    ns.reset();
    expect(ns.instances().size).toBe(0);
    expect(ns.fetches).toHaveLength(0);
  });
});

describe('createFakeQueue', () => {
  it('records sends and drains', async () => {
    const queue = createFakeQueue<{ n: number }>();
    await queue.send({ n: 1 });
    await queue.send({ n: 2 }, { delaySeconds: 5, contentType: 'json' });
    await queue.sendBatch([{ body: { n: 3 } }, { body: { n: 4 }, contentType: 'v8' }]);
    expect(queue.size).toBe(4);
    expect(queue.messages.map((m) => m.body.n)).toEqual([1, 2, 3, 4]);
    expect(queue.messages[1]).toMatchObject({ delaySeconds: 5, contentType: 'json', attempts: 1 });
    expect(queue.messages[3]?.contentType).toBe('v8');
    const batch = queue.drain();
    expect(batch).toHaveLength(4);
    expect(batch[0]?.id).toBe('msg-1');
    expect(queue.size).toBe(0);
  });
});

describe('createFakeAnalyticsEngine', () => {
  it('records data points', () => {
    const ae = createFakeAnalyticsEngine();
    ae.writeDataPoint({ indexes: ['route'], blobs: ['a', null], doubles: [1.5] });
    ae.writeDataPoint({});
    expect(ae.size).toBe(2);
    expect(ae.dataPoints[0]).toEqual({ indexes: ['route'], blobs: ['a', null], doubles: [1.5] });
    expect(ae.dataPoints[1]).toEqual({ indexes: [], blobs: [], doubles: [] });
    ae.clear();
    expect(ae.size).toBe(0);
  });
});

describe('createFakeExecutionContext', () => {
  it('tracks waitUntil promises, including nested ones, and collects rejections', async () => {
    const ctx = createFakeExecutionContext({ user: 'x' });
    const order: string[] = [];
    ctx.waitUntil(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push('first');
          ctx.waitUntil(Promise.resolve().then(() => void order.push('nested')));
          resolve();
        }, 5),
      ),
    );
    ctx.waitUntil(Promise.reject(new Error('boom')));
    expect(ctx.pending).toBe(2);
    await ctx.flush();
    expect(ctx.pending).toBe(0);
    expect(order).toEqual(['first', 'nested']);
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.props).toEqual({ user: 'x' });
    expect(ctx.passedThrough).toBe(false);
    ctx.passThroughOnException();
    expect(ctx.passedThrough).toBe(true);
  });
});

describe('createFakeRateLimitBinding', () => {
  it('allows `limit` requests per fixed window per key', async () => {
    const clock = createClock(Date.UTC(2026, 0, 1));
    const binding = createFakeRateLimitBinding({ limit: 2, periodSeconds: 10, clock });
    expect(await binding.limit({ key: 'ip:1' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'ip:1' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'ip:1' })).toEqual({ success: false });
    expect(await binding.limit({ key: 'ip:2' })).toEqual({ success: true });
    expect(binding.counts()).toEqual({ 'ip:1': 3, 'ip:2': 1 });
    clock.tick(10);
    expect(await binding.limit({ key: 'ip:1' })).toEqual({ success: true });
    expect(binding.counts()).toEqual({ 'ip:1': 1 });
    binding.reset();
    expect(binding.counts()).toEqual({});
  });
});

import { type ResolvedRateLimitPolicy, resolveConfig } from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { fakeCache, fakeClock, fakeKv, makeCtx, runStage } from '../__tests__/helpers';
import { RATE_LIMIT_KEY } from '../keys';
import { rateLimitHeaders } from './headers';
import { createRateLimiter } from './limiter';
import { rateLimitStage, resolveRateLimitKey } from './stage';
import { createCacheApiCounterStore, createKvCounterStore, createMemoryCounterStore } from './stores';
import type { CounterStore } from './types';

function policy(partial: Partial<ResolvedRateLimitPolicy> = {}): ResolvedRateLimitPolicy {
  const base = resolveConfig({
    security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 3, window: '10s' }] },
  }).security.rateLimit[0]!;
  return { ...base, ...partial };
}

describe('algorithms (memory store, fake clock)', () => {
  it('fixed window counts per window and resets', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const p = policy({ algorithm: 'fixed-window' });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.check(p, 'k', clock.now()));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfter).toBe(10);
    expect(results[3]!.resetAt).toBe(1_700_000_010_000);
    expect(results[3]!.window).toBe(10);
    clock.advance(10_000);
    expect((await limiter.check(p, 'k', clock.now())).allowed).toBe(true);
  });

  it('sliding window weighs the previous window', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const store = createMemoryCounterStore();
    const limiter = createRateLimiter({ store });
    const p = policy({ algorithm: 'sliding-window' });
    for (let i = 0; i < 3; i++) await limiter.check(p, 'k', clock.now());
    // 10% into the next window: 3 * 0.9 + 1 = 3.7 > 3 → denied
    clock.advance(11_000);
    const denied = await limiter.check(p, 'k', clock.now());
    expect(denied.allowed).toBe(false);
    // 90% into the window: 3 * 0.1 + 2 = 2.3 → allowed
    clock.advance(8_000);
    const allowed = await limiter.check(p, 'k', clock.now());
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(0);
  });

  it('token bucket refills continuously (capacity = limit + burst)', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const p = policy({ algorithm: 'token-bucket', limit: 2, burst: 1, windowSeconds: 10 }); // 3 tokens, 0.2/s
    const first = [];
    for (let i = 0; i < 4; i++) first.push(await limiter.check(p, 'k', clock.now()));
    expect(first.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(first[0]!.limit).toBe(3);
    expect(first[3]!.retryAfter).toBe(5);
    clock.advance(5_000);
    expect((await limiter.check(p, 'k', clock.now())).allowed).toBe(true);
    expect((await limiter.check(p, 'k', clock.now())).allowed).toBe(false);
  });

  it('emulates sliding and bucket on increment-only stores', async () => {
    const base = createMemoryCounterStore();
    const incrementOnly: CounterStore = { increment: base.increment.bind(base) };
    const limiter = createRateLimiter({ store: incrementOnly });
    const clock = fakeClock();
    const sliding = policy({ algorithm: 'sliding-window' });
    const bucket = policy({ algorithm: 'token-bucket', limit: 2, burst: 0 });
    for (let i = 0; i < 3; i++) expect((await limiter.check(sliding, 's', clock.now())).allowed).toBe(true);
    expect((await limiter.check(sliding, 's', clock.now())).allowed).toBe(false);
    expect((await limiter.check(bucket, 'b', clock.now())).allowed).toBe(true);
    expect((await limiter.check(bucket, 'b', clock.now())).allowed).toBe(true);
    expect((await limiter.check(bucket, 'b', clock.now())).allowed).toBe(false);
  });

  it('fails open on store errors unless configured otherwise', async () => {
    const broken: CounterStore = {
      increment: async () => {
        throw new Error('kv down');
      },
    };
    const onError = vi.fn();
    const open = createRateLimiter({ store: broken, onError });
    const r = await open.check(policy({ algorithm: 'fixed-window' }), 'k');
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    const closed = createRateLimiter({ store: broken, failOpen: false });
    await expect(closed.check(policy({ algorithm: 'fixed-window' }), 'k')).rejects.toThrow('kv down');
  });
});

describe('stores', () => {
  it('cache api store (approximate) counts, slides and buckets', async () => {
    const cache = fakeCache();
    const store = createCacheApiCounterStore({ cache });
    const now = Date.now();
    expect((await store.increment('k', 10, now)).count).toBe(1);
    expect((await store.increment('k', 10, now)).count).toBe(2);
    expect([...cache.map.keys()][0]).toMatch(/^https:\/\/hypdriv\.ratelimit\/k\/\d+$/);
    expect(cache.map.values().next().value?.headers.get('cache-control')).toBe('max-age=20');
    const sliding = await store.slidingCount!('k', 10, now);
    expect(sliding.count).toBeGreaterThanOrEqual(3);
    const t1 = await store.takeToken!('b', 2, 1, now);
    const t2 = await store.takeToken!('b', 2, 1, now);
    const t3 = await store.takeToken!('b', 2, 1, now);
    expect([t1.allowed, t2.allowed, t3.allowed]).toEqual([true, true, false]);
    expect((await store.takeToken!('b', 2, 1, now + 1000)).allowed).toBe(true);
  });

  it('kv store uses expirationTtl ≥ 60 and supports all three operations', async () => {
    const kv = fakeKv();
    const store = createKvCounterStore(kv);
    const now = Date.now();
    await store.increment('k', 10, now);
    const r = await store.increment('k', 10, now);
    expect(r.count).toBe(2);
    expect([...kv.map.keys()][0]).toMatch(/^hypdriv:rl:k:\d+$/);
    expect((await store.slidingCount!('k', 10, now)).count).toBe(3);
    expect((await store.takeToken!('b', 1, 1, now)).allowed).toBe(true);
    expect((await store.takeToken!('b', 1, 1, now)).allowed).toBe(false);
  });

  it('cache api store throws a clear error when caches.default is missing', async () => {
    const store = createCacheApiCounterStore();
    await expect(store.increment('k', 10, Date.now())).rejects.toThrow(/caches.default/);
  });

  it('memory store sweeps expired windows', async () => {
    const store = createMemoryCounterStore({ maxEntries: 10 });
    const clock = fakeClock();
    for (let i = 0; i < 300; i++) await store.increment(`k${i}`, 1, clock.now());
    clock.advance(5_000);
    for (let i = 0; i < 300; i++) await store.increment(`n${i}`, 1, clock.now());
    expect((await store.increment('k0', 1, clock.now())).count).toBe(1);
  });
});

describe('binding store', () => {
  it('uses the Rate Limiting binding when the policy asks for it', async () => {
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: key !== 'blocked' }));
    const limiter = createRateLimiter({ store: createMemoryCounterStore(), binding: { limit } });
    const p = policy({ store: 'binding' });
    const ok = await limiter.check(p, 'fine');
    const denied = await limiter.check(p, 'blocked');
    expect(ok).toMatchObject({ allowed: true, remaining: 1, limit: 3 });
    expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfter: 10 });
    expect(limit).toHaveBeenCalledWith({ key: 'fine' });
    // without a binding the policy falls back to the counter store
    const fallback = createRateLimiter({ store: createMemoryCounterStore() });
    expect((await fallback.check(p, 'x')).remaining).toBe(2);
  });
});

describe('headers and keys', () => {
  it('rateLimitHeaders renders IETF, legacy and Retry-After', () => {
    const now = 1_700_000_000_000;
    const allowed = rateLimitHeaders(
      { allowed: true, limit: 100, remaining: 42, resetAt: now + 17_000, retryAfter: 0, window: 60 },
      'api',
      now,
    );
    expect(allowed).toEqual({
      RateLimit: '"api";r=42;t=17',
      'RateLimit-Policy': '"api";q=100;w=60',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': String(Math.ceil((now + 17_000) / 1000)),
    });
    const limited = rateLimitHeaders(
      { allowed: false, limit: 100, remaining: 0, resetAt: now + 17_000, retryAfter: 17, window: 60 },
      'a"b',
      now,
    );
    expect(limited['Retry-After']).toBe('17');
    expect(limited.RateLimit).toBe('"ab";r=0;t=17');
  });

  it('resolveRateLimitKey joins the policy id with each dimension', () => {
    const p = policy({ keys: ['ip', 'session', 'user', 'api-key', 'path', 'global'] });
    const ctx = makeCtx({
      url: 'https://app.test/api/items?x=1',
      ip: '198.51.100.9',
      headers: {
        cookie: 'hyp_session=abc; other=1',
        'x-user-id': 'u 42|x',
        authorization: 'Bearer secret-token',
      },
    });
    const key = resolveRateLimitKey(p, ctx);
    expect(key.startsWith('api|ip=198.51.100.9|session=')).toBe(true);
    expect(key).not.toContain('abc');
    expect(key).not.toContain('secret-token');
    expect(key).toContain('|user=u42x|');
    expect(key).toContain('|path=/api/items|global');
    const anon = resolveRateLimitKey(p, makeCtx({ url: 'https://app.test/api/x' }));
    expect(anon).toContain('|session=-|user=-|api-key=-|');
  });
});

describe('rateLimitStage', () => {
  const config = resolveConfig({
    security: {
      rateLimit: [
        {
          id: 'login',
          match: '/api/login',
          methods: ['POST'],
          limit: 1,
          window: '1m',
          algorithm: 'fixed-window',
        },
        {
          id: 'api',
          match: '/api/**',
          limit: 5,
          window: '1m',
          algorithm: 'fixed-window',
          skip: ({ headers }) => headers.has('x-internal'),
        },
        { id: 'silent', match: '/api/**', limit: 100, window: '1m', headers: false },
      ],
    },
  });

  it('denies with the configured response and sets headers for the tightest policy otherwise', async () => {
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const stage = rateLimitStage(config, limiter);
    const first = makeCtx({ config, url: 'https://app.test/api/login', method: 'POST' });
    const r1 = await runStage(stage, first, () => new Response('ok'));
    expect(r1.shortCircuited).toBe(false);
    // Windows align to wall-clock boundaries, so the reset is within the window length.
    expect(r1.response.headers.get('ratelimit')).toMatch(/^"login";r=0;t=(?:[1-9]|[1-5]\d|60)$/);
    expect(r1.response.headers.get('ratelimit-policy')).toBe('"login";q=1;w=60');
    expect(first.state.get(RATE_LIMIT_KEY)?.map((e) => e.policy)).toEqual(['login', 'api', 'silent']);

    const second = makeCtx({ config, url: 'https://app.test/api/login', method: 'POST' });
    const r2 = await runStage(stage, second, () => new Response('ok'));
    expect(r2.shortCircuited).toBe(true);
    expect(r2.response.status).toBe(429);
    expect(Number(r2.response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(r2.response.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(r2.response.headers.get('content-type')).toContain('application/json');
    expect(await r2.response.json()).toEqual({ error: 'rate_limited', policy: 'login' });
    expect(second.timings.list()).toContainEqual({ name: 'limit', desc: 'login' });
    expect(second.state.get(RATE_LIMIT_KEY)).toEqual([
      { policy: 'login', remaining: 0, limit: 1, reset: expect.any(Number) },
    ]);
  });

  it('honours methods, skip predicates and custom responses', async () => {
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const stage = rateLimitStage(config, limiter);
    const get = makeCtx({ config, url: 'https://app.test/api/login', method: 'GET' });
    await runStage(stage, get, () => new Response('ok'));
    expect(get.state.get(RATE_LIMIT_KEY)?.map((e) => e.policy)).toEqual(['api', 'silent']);
    const internal = makeCtx({ config, url: 'https://app.test/api/x', headers: { 'x-internal': '1' } });
    await runStage(stage, internal, () => new Response('ok'));
    expect(internal.state.get(RATE_LIMIT_KEY)?.map((e) => e.policy)).toEqual(['silent']);

    const custom = resolveConfig({
      security: {
        rateLimit: [
          {
            id: 'c',
            match: '/**',
            limit: 0,
            window: 60,
            response: { status: 503, body: 'slow down', headers: { 'x-why': 'quota' } },
          },
        ],
      },
    });
    const ctx = makeCtx({ config: custom, url: 'https://app.test/' });
    const { response } = await runStage(rateLimitStage(custom, limiter), ctx, () => new Response('ok'));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('slow down');
    expect(response.headers.get('x-why')).toBe('quota');
    expect(response.headers.get('retry-after')).toBeTruthy();
  });
});

import { HypDrivError, loadConfig } from '@hypdriv/core';
import { createRateLimiter, takeFromBucket } from '@hypdriv/security';
import { describe, expect, it } from 'vitest';
import { createFakeUpstash } from './__fixtures__/fakes';
import {
  createUpstashClient,
  escapeGlob,
  TOKEN_BUCKET_SCRIPT,
  upstashCounterStore,
  upstashKv,
} from './upstash';

const URL_ = 'https://us1-fake.upstash.io';

function kvWith(fake = createFakeUpstash(), prefix?: string) {
  return {
    fake,
    kv: upstashKv({
      url: URL_,
      token: 'test-token',
      fetch: fake.fetch,
      ...(prefix !== undefined ? { prefix } : {}),
    }),
  };
}

describe('createUpstashClient', () => {
  it('validates url and token', () => {
    expect(() => createUpstashClient({ url: 'ftp://x', token: 't' })).toThrow(TypeError);
    expect(() => createUpstashClient({ url: URL_, token: ' ' })).toThrow(TypeError);
  });

  it('sends commands with bearer auth to the root and batches to /pipeline', async () => {
    const fake = createFakeUpstash();
    const client = createUpstashClient({ url: `${URL_}/`, token: 'test-token', fetch: fake.fetch });
    expect(await client.command(['SET', 'a', '1'])).toBe('OK');
    expect(
      await client.pipeline([
        ['INCR', 'n'],
        ['INCR', 'n'],
        ['GET', 'a'],
      ]),
    ).toEqual([1, 2, '1']);
    expect(await client.pipeline([])).toEqual([]);
    expect(fake.requests.map((r) => r.path)).toEqual(['/', '/pipeline']);
    expect(fake.requests[0]!.authorization).toBe('Bearer test-token');
  });

  it('maps HTTP and command errors to HypDrivError without leaking the token', async () => {
    const fake = createFakeUpstash();
    const bad = createUpstashClient({ url: URL_, token: 'wrong', fetch: fake.fetch });
    const error = await bad.command(['GET', 'a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HypDrivError);
    expect((error as HypDrivError).code).toBe('E_UPSTREAM');
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('wrong');

    const client = createUpstashClient({ url: URL_, token: 'test-token', fetch: fake.fetch });
    await expect(client.command(['NOPE'])).rejects.toThrow(/unknown command/);
    await expect(client.pipeline([['GET', 'a'], ['NOPE']])).rejects.toThrow(/command 2 \(NOPE\) failed/);
    fake.failNext(500, 'not json');
    await expect(client.command(['GET', 'a'])).rejects.toThrow(/HTTP 500/);
  });

  it('times out slow requests with E_TIMEOUT', async () => {
    const slow = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const client = createUpstashClient({ url: URL_, token: 't', fetch: slow, timeoutMs: 5 });
    const error = await client.command(['GET', 'a']).catch((e: unknown) => e);
    expect((error as HypDrivError).code).toBe('E_TIMEOUT');
  });

  it('wraps network failures as E_UPSTREAM', async () => {
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = createUpstashClient({ url: URL_, token: 't', fetch: broken });
    await expect(client.command(['GET', 'a'])).rejects.toMatchObject({ code: 'E_UPSTREAM' });
  });
});

describe('upstashKv', () => {
  it('round-trips text, json and binary values under the prefix', async () => {
    const { fake, kv } = kvWith();
    expect(kv.name).toBe('upstash');
    await kv.put('greeting', 'héllo');
    await kv.put('doc', JSON.stringify({ a: [1, 2] }));
    await kv.put('bin', new Uint8Array([0, 255, 10, 13]));
    await kv.put('view', new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2));
    expect(await kv.get('greeting')).toBe('héllo');
    expect(await kv.get('greeting', 'text')).toBe('héllo');
    expect(await kv.get('doc', 'json')).toEqual({ a: [1, 2] });
    expect(await kv.get('doc', { type: 'json' })).toEqual({ a: [1, 2] });
    const bin = (await kv.get('bin', 'arrayBuffer')) as ArrayBuffer;
    expect([...new Uint8Array(bin)]).toEqual([0, 255, 10, 13]);
    expect([...new Uint8Array((await kv.get('view', 'arrayBuffer')) as ArrayBuffer)]).toEqual([8, 7]);
    expect([...new Uint8Array((await kv.get('greeting', 'arrayBuffer')) as ArrayBuffer)]).toEqual([
      ...new TextEncoder().encode('héllo'),
    ]);
    expect(await kv.get('missing')).toBeNull();
    expect(await kv.get('missing', 'json')).toBeNull();
    expect([...fake.data.keys()].every((k) => k.startsWith('hypdriv:'))).toBe(true);
    expect(fake.data.get('hypdriv:bin')!.value).toMatch(/^~hypdriv:b64~/);
  });

  it('stores ReadableStream values as binary', async () => {
    const { kv } = kvWith();
    await kv.put('stream', new Response('streamed body').body!);
    expect(await kv.get('stream')).toBe('streamed body');
  });

  it('escapes text that starts with the reserved marker prefix', async () => {
    const { fake, kv } = kvWith();
    await kv.put('tricky', '~hypdriv:b64~not-binary');
    expect(fake.data.get('hypdriv:tricky')!.value).toBe('~hypdriv:txt~~hypdriv:b64~not-binary');
    expect(await kv.get('tricky')).toBe('~hypdriv:b64~not-binary');
  });

  it('reads values written by other Redis clients as plain text', async () => {
    const { fake, kv } = kvWith();
    fake.data.set('hypdriv:flags', { value: '{"beta":{"default":true}}' });
    expect(await kv.get('flags', 'json')).toEqual({ beta: { default: true } });
  });

  it('maps expirationTtl to EX (winning over expiration) and expiration to EXAT', async () => {
    const { fake, kv } = kvWith();
    await kv.put('a', '1', { expirationTtl: 59.2 });
    await kv.put('b', '1', { expiration: 1_800_000_000.7 });
    await kv.put('c', '1', { expirationTtl: 30, expiration: 1_800_000_000 });
    await kv.put('d', '1', { metadata: { ignored: true } });
    expect(fake.commands).toEqual([
      ['SET', 'hypdriv:a', '1', 'EX', 60],
      ['SET', 'hypdriv:b', '1', 'EXAT', 1_800_000_000],
      ['SET', 'hypdriv:c', '1', 'EX', 30],
      ['SET', 'hypdriv:d', '1'],
    ]);
    fake.setNow(fake.now() + 61_000);
    expect(await kv.get('a')).toBeNull();
    expect(await kv.get('d')).toBe('1');
  });

  it('deletes keys', async () => {
    const { kv } = kvWith();
    await kv.put('a', '1');
    await kv.delete('a');
    expect(await kv.get('a')).toBeNull();
  });

  it('lists keys by prefix with SCAN, paging through cursors', async () => {
    const fake = createFakeUpstash({ scanPage: 2 });
    const { kv } = kvWith(fake);
    for (const key of ['tag:a', 'tag:b', 'tag:c', 'other', 'tag:d']) await kv.put(key, '1');
    fake.data.set('foreign:tag:x', { value: '1' });
    const all = await kv.list!({ prefix: 'tag:' });
    expect(all.keys.map((k) => k.name).sort()).toEqual(['tag:a', 'tag:b', 'tag:c', 'tag:d']);
    expect(all.list_complete).toBe(true);
    expect(all.cursor).toBeUndefined();

    const first = await kv.list!({ prefix: 'tag:', limit: 1 });
    expect(first.keys.length).toBeGreaterThanOrEqual(1);
    expect(first.list_complete).toBe(false);
    const rest = await kv.list!({ prefix: 'tag:', cursor: first.cursor! });
    const names = [...first.keys, ...rest.keys].map((k) => k.name).sort();
    expect(names).toEqual(['tag:a', 'tag:b', 'tag:c', 'tag:d']);
    const scan = fake.commands.find((c) => c[0] === 'SCAN')!;
    expect(scan).toEqual(['SCAN', '0', 'MATCH', 'hypdriv:tag:*', 'COUNT', 1000]);
  });

  it('escapes glob metacharacters in list prefixes', async () => {
    expect(escapeGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f');
    const { fake, kv } = kvWith(createFakeUpstash({ scanPage: 100 }), 'app:');
    await kv.put('x*1', '1');
    await kv.put('xy', '1');
    const page = await kv.list!({ prefix: 'x*' });
    expect(page.keys.map((k) => k.name)).toEqual(['x*1']);
    expect(fake.commands.at(-1)![3]).toBe('app:x\\**');
  });
});

describe('upstashCounterStore', () => {
  const store = (fake = createFakeUpstash()) => ({
    fake,
    counters: upstashCounterStore({ url: URL_, token: 'test-token', fetch: fake.fetch }),
  });

  it('counts a fixed window atomically and sets the expiry only once', async () => {
    const { fake, counters } = store();
    const now = 1_700_000_005_500;
    const a = await counters.increment('api|ip=1', 10, now);
    const b = await counters.increment('api|ip=1', 10, now + 1000);
    expect(a).toEqual({ count: 1, resetAt: 1_700_000_010_000 });
    expect(b.count).toBe(2);
    expect(fake.requests.every((r) => r.path === '/pipeline')).toBe(true);
    expect(fake.commands.slice(0, 2)).toEqual([
      ['INCR', 'hypdriv:rl:api|ip=1:1700000000000'],
      ['PEXPIRE', 'hypdriv:rl:api|ip=1:1700000000000', 20_000, 'NX'],
    ]);
    // The second PEXPIRE NX does not extend the first expiry.
    expect(fake.data.get('hypdriv:rl:api|ip=1:1700000000000')!.expiresAt).toBe(fake.now() + 20_000);
    const next = await counters.increment('api|ip=1', 10, now + 5000);
    expect(next).toEqual({ count: 1, resetAt: 1_700_000_020_000 });
  });

  it('weights the previous window for sliding counts', async () => {
    const { fake, counters } = store();
    for (let i = 0; i < 4; i++) await counters.slidingCount!('k', 10, 1_700_000_001_000);
    // 25 % into the next window: 4 * 0.75 + 1
    const r = await counters.slidingCount!('k', 10, 1_700_000_012_500);
    expect(r.count).toBeCloseTo(4, 5);
    expect(r.resetAt).toBe(1_700_000_020_000);
    expect(fake.commands.at(-1)).toEqual(['GET', 'hypdriv:rl:k:1700000000000']);
  });

  it('runs the token bucket script with EVALSHA, falling back to EVAL once', async () => {
    const { fake, counters } = store();
    const now = 1_700_000_000_000;
    const first = await counters.takeToken!('bucket', 2, 1, now);
    const second = await counters.takeToken!('bucket', 2, 1, now);
    const third = await counters.takeToken!('bucket', 2, 1, now);
    expect(first).toEqual({ allowed: true, remaining: 1, resetAt: now + 1000 });
    expect(second).toEqual({ allowed: true, remaining: 0, resetAt: now + 2000 });
    expect(third).toEqual({ allowed: false, remaining: 0, resetAt: now + 1000 });
    const names = fake.commands.map((c) => c[0]);
    expect(names).toEqual(['EVALSHA', 'EVAL', 'EVALSHA', 'EVALSHA']);
    const evalsha = fake.commands[0]!;
    expect(evalsha[2]).toBe(1);
    expect(evalsha.slice(3)).toEqual(['hypdriv:rl:bucket:bucket', 2, 1, now, 62_000]);
    // Refill after 1.5 s: 1.5 tokens → allowed, 0.5 left.
    const later = await counters.takeToken!('bucket', 2, 1, now + 1500);
    const expected = takeFromBucket({ tokens: 0, updatedAt: now }, 2, 1, now + 1500).result;
    expect(later).toEqual(expected);
  });

  it('propagates script errors other than NOSCRIPT', async () => {
    const fake = createFakeUpstash();
    const counters = upstashCounterStore({ url: URL_, token: 'test-token', fetch: fake.fetch });
    fake.failNext(400, { error: 'ERR busy' });
    await expect(counters.takeToken!('b', 1, 1, 0)).rejects.toThrow(/busy/);
  });

  it('works as the store of the Hypdriv rate limiter', async () => {
    const { counters } = store();
    const config = loadConfig({
      security: {
        rateLimit: [{ id: 'api', match: '/api/**', limit: 2, window: '1m', algorithm: 'sliding-window' }],
      },
    });
    const limiter = createRateLimiter({ store: counters, failOpen: false });
    const policy = config.security.rateLimit[0]!;
    const now = 1_700_000_000_000;
    expect((await limiter.check(policy, 'api|ip=1', now)).allowed).toBe(true);
    expect((await limiter.check(policy, 'api|ip=1', now)).allowed).toBe(true);
    const third = await limiter.check(policy, 'api|ip=1', now);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it('keeps the Lua script atomic and self-contained', () => {
    expect(TOKEN_BUCKET_SCRIPT).toContain("redis.call('HMGET', key, 'tokens', 'updatedAt')");
    expect(TOKEN_BUCKET_SCRIPT).toContain("redis.call('PEXPIRE', key, ttl)");
    expect(TOKEN_BUCKET_SCRIPT).toContain('tostring(tokens)');
  });
});

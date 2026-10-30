import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HypDrivIndex, HypDrivLimiter } from './durable-objects/index';

interface TestEnv {
  HYPDRIV_LIMITER: DurableObjectNamespace<HypDrivLimiter>;
  HYPDRIV_INDEX: DurableObjectNamespace<HypDrivIndex>;
}
const testEnv = env as unknown as TestEnv;

const browser = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
};

describe('createWorker in workerd', () => {
  it('streams HTML through HTMLRewriter edge stages', async () => {
    const response = await SELF.fetch('https://shop.example.com/', { headers: browser });
    expect(response.status).toBe(200);
    const body = await response.text();
    // developer comments are stripped, React boundaries kept
    expect(body).not.toContain('a developer comment');
    expect(body).toContain('<!--$-->');
    expect(body).toContain('<!--/$-->');
    // the likely-LCP image is prioritised and no longer lazy
    expect(body).toMatch(
      /<img src="\/hero.jpg" class="hero" fetchpriority="high">|<img[^>]*fetchpriority="high"[^>]*>/,
    );
    expect(body).not.toContain('loading="lazy"');
    // whitespace is preserved inside <pre>
    expect(body).toContain('<pre>  keep   this  </pre>');
    expect(response.headers.get('x-hypdriv-request-id')).toBeTruthy();
    expect(
      response.headers.get('content-security-policy') ??
        response.headers.get('content-security-policy-report-only'),
    ).toBeTruthy();
  });

  it('rate limits exactly through the HypDrivLimiter Durable Object', async () => {
    const headers = { ...browser, accept: 'application/json', 'cf-connecting-ip': '203.0.113.7' };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await SELF.fetch('https://shop.example.com/api/ping', { headers });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('answers health with Durable Object capabilities detected', async () => {
    const response = await SELF.fetch('https://shop.example.com/_hypdriv/health');
    const body = (await response.json()) as { ok: boolean; build: string; capabilities: string[] };
    expect(body.ok).toBe(true);
    expect(body.build).toBe('workers-test');
    expect(body.capabilities.join(' ')).toMatch(/Durable Object/i);
  });
});

describe('HypDrivLimiter', () => {
  it('counts fixed and sliding windows and hands out tokens', async () => {
    const stub = testEnv.HYPDRIV_LIMITER.get(testEnv.HYPDRIV_LIMITER.idFromName('limiter-test'));
    const t0 = 1_800_000_000_000;
    expect(await stub.increment('k', 60, t0)).toEqual({
      count: 1,
      resetAt: Math.floor(t0 / 60_000) * 60_000 + 60_000,
    });
    expect((await stub.increment('k', 60, t0 + 1)).count).toBe(2);
    // next window: sliding estimate includes the weighted previous window
    const next = Math.floor(t0 / 60_000) * 60_000 + 60_000;
    const sliding = await stub.slidingCount('k', 60, next + 30_000);
    expect(sliding.count).toBe(2); // 2 * 0.5 + 1
    expect(await stub.takeToken('b', 2, 1, t0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await stub.takeToken('b', 2, 1, t0)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await stub.takeToken('b', 2, 1, t0)).toMatchObject({ allowed: false });
    expect(await stub.takeToken('b', 2, 1, t0 + 1000)).toMatchObject({ allowed: true });
  });

  it('grants locks to one holder at a time and persists state', async () => {
    const id = testEnv.HYPDRIV_LIMITER.idFromName('lock-test');
    const stub = testEnv.HYPDRIV_LIMITER.get(id);
    const now = Date.now();
    expect(await stub.lock('render', 'a', 5000, now)).toMatchObject({ acquired: true, holder: 'a' });
    expect(await stub.lock('render', 'b', 5000, now)).toMatchObject({ acquired: false, holder: 'a' });
    expect(await stub.unlock('render', 'b')).toBe(false);
    expect(await stub.unlock('render', 'a')).toBe(true);
    expect(await stub.lock('render', 'b', 5000, now)).toMatchObject({ acquired: true, holder: 'b' });
    await runInDurableObject(stub, async (_instance, state) => {
      const locks = await state.storage.get<Record<string, unknown>>('locks');
      expect(Object.keys(locks ?? {})).toEqual(['render']);
    });
  });

  it('speaks the JSON fetch transport', async () => {
    const stub = testEnv.HYPDRIV_LIMITER.get(testEnv.HYPDRIV_LIMITER.idFromName('fetch-test'));
    const res = await stub.fetch('https://hypdriv.do/', {
      method: 'POST',
      body: JSON.stringify({ op: 'increment', args: ['x', 10, 0] }),
    });
    expect(await res.json()).toEqual({ count: 1, resetAt: 10_000 });
    const bad = await stub.fetch('https://hypdriv.do/', {
      method: 'POST',
      body: JSON.stringify({ op: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('HypDrivIndex', () => {
  it('stores tag associations in SQLite and purges them', async () => {
    const stub = testEnv.HYPDRIV_INDEX.get(testEnv.HYPDRIV_INDEX.idFromName('shard:0'));
    const now = Date.now();
    await stub.add('key-a', ['blog', 'post:1'], 600, now);
    await stub.add('key-b', ['blog'], 600, now);
    expect((await stub.keysFor(['blog'], now)).sort()).toEqual(['key-a', 'key-b']);
    expect(await stub.keysFor(['post:1'], now + 601_000)).toEqual([]);
    expect(await stub.stats()).toEqual({ associations: 3, tags: 2 });
    expect(await stub.remove(['key-a'])).toBe(2);
    expect(await stub.keysFor(['blog', 'post:1'], now)).toEqual(['key-b']);
    expect(await stub.clearTags(['blog'])).toBe(1);
    expect(await stub.stats()).toEqual({ associations: 0, tags: 0 });
  });

  it('keeps purge tombstones so entries fetched before a purge are never indexed', async () => {
    const stub = testEnv.HYPDRIV_INDEX.get(testEnv.HYPDRIV_INDEX.idFromName('shard:tombstones'));
    const now = Date.now();
    await stub.markPurged(['news'], now + 5000);
    // Fetched before / inside the window: stale, nothing indexed.
    expect(await stub.add('key-old', ['news', 'home'], 600, now, now - 1000)).toEqual({ stale: true });
    expect(await stub.add('key-mid', ['news'], 600, now, now + 4000)).toEqual({ stale: true });
    expect(await stub.keysFor(['news', 'home'], now)).toEqual([]);
    // Fetched after the window, or for other tags: indexed.
    expect(await stub.add('key-new', ['news'], 600, now, now + 6000)).toEqual({ stale: false });
    expect(await stub.add('key-other', ['sports'], 600, now, now - 1000)).toEqual({ stale: false });
    expect((await stub.keysFor(['news', 'sports'], now)).sort()).toEqual(['key-new', 'key-other']);
    // Tombstones only move forward.
    await stub.markPurged(['news'], now + 1000);
    expect(await stub.add('key-again', ['news'], 600, now, now + 4500)).toEqual({ stale: true });
    // Without fetchedAt (older clients), behaviour is unchanged.
    expect(await stub.add('key-legacy', ['news'], 600, now)).toEqual({ stale: false });
  });
});

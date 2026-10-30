import {
  flushContext,
  type GeoProperties,
  type HypDrivConfig,
  type HypManifest,
  type RouteMatch,
  runPipeline,
} from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, makeManifest, makeRoute } from './__fixtures__/fakes';
import { createEdgeCache } from './stage';
import { CACHE_DECISION_KEY, UPSTREAM_KEY } from './state';
import { createMemoryStore } from './stores/memory';
import { createMemoryTagIndex } from './tags/memory';
import type { CacheStore, EdgeCacheOptions, Purger, TagIndex } from './types';

const NOW = 1_700_000_000_000;

const manifest = makeManifest([
  makeRoute({ pathname: '/', classification: 'static' }),
  makeRoute({ pathname: '/blog/[slug]', classification: 'static' }),
  makeRoute({ pathname: '/account', classification: 'dynamic' }),
  makeRoute({ pathname: '/search', classification: 'dynamic' }),
]);

interface HarnessOptions {
  config?: HypDrivConfig;
  manifest?: HypManifest;
  store?: CacheStore;
  tagIndex?: TagIndex;
  purger?: Purger;
  coalesceTimeoutMs?: number;
  resolvers?: EdgeCacheOptions['resolvers'];
}

interface RequestOptions {
  next?: (request: Request) => Promise<Response> | Response;
  /** `state`: runner routes `next` through UPSTREAM_KEY (default); `direct`: plain next; `none`: no upstream exposed. */
  runner?: 'state' | 'direct' | 'none';
  cf?: GeoProperties;
  route?: RouteMatch | null;
  skipEdgeOnly?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let now = NOW;
  const clock = () => now;
  const store = options.store ?? createMemoryStore({ now: clock });
  const edgeCache = createEdgeCache({
    store,
    now: clock,
    tagIndex: options.tagIndex,
    purger: options.purger,
    coalesceTimeoutMs: options.coalesceTimeoutMs,
    resolvers: options.resolvers,
  });
  const stage = edgeCache.stage();
  const upstreamCalls: Request[] = [];
  const config = options.config ?? {
    cache: {
      edge: {
        policies: [
          { id: 'search', match: '/search', ttl: 60, swr: 120, staleIfError: 300, tags: ['search'] },
        ],
        inferredStatic: { ttl: 60, swr: 120, staleIfError: 300 },
      },
    },
  };

  async function request(url: string, init: RequestInit = {}, o: RequestOptions = {}) {
    const ctx = makeCtx(new Request(url, init), {
      config,
      manifest: options.manifest ?? manifest,
      cf: o.cf,
      ...(o.route !== undefined ? { route: o.route } : {}),
    });
    const upstream = async (req: Request) => {
      const index = upstreamCalls.length;
      upstreamCalls.push(req);
      if (o.next) return o.next(req);
      return new Response(`body:${index}`, { headers: { 'content-type': 'text/html' } });
    };
    const runner = o.runner ?? 'state';
    if (runner === 'state') ctx.state.set(UPSTREAM_KEY, upstream);
    const result = await runPipeline({
      stages: [stage],
      ctx,
      next: runner === 'state' ? (req) => ctx.state.get(UPSTREAM_KEY)!(req) : upstream,
      skipEdgeOnly: o.skipEdgeOnly,
    });
    return { ...result, ctx, decision: ctx.state.get(CACHE_DECISION_KEY)!, flush: () => flushContext(ctx) };
  }

  return {
    edgeCache,
    store,
    upstreamCalls,
    request,
    advance(ms: number) {
      now += ms;
    },
  };
}

const text = (r: Response) => r.text();

describe('edge-cache stage: non-cacheable requests', () => {
  it('reports DYNAMIC for unsupported methods, missing policies and a disabled cache', async () => {
    const h = harness();
    const post = await h.request('https://x.test/blog/a', { method: 'POST' });
    expect(post.decision).toMatchObject({ status: 'DYNAMIC', reason: 'method:POST' });
    expect(post.response.headers.get('x-hypdriv-cache')).toBe('DYNAMIC');
    expect(post.response.headers.get('cache-tag')).toBeNull();
    const dyn = await h.request('https://x.test/account');
    expect(dyn.decision).toMatchObject({ status: 'DYNAMIC', reason: 'no-policy' });
    expect(h.upstreamCalls).toHaveLength(2);
    expect(dyn.ctx.timings.list()).toContainEqual({ name: 'cache', desc: 'DYNAMIC' });

    const off = harness({ config: { cache: { edge: false } } });
    const res = await off.request('https://x.test/blog/a');
    expect(res.decision).toMatchObject({ status: 'DYNAMIC', reason: 'disabled' });
    expect(res.response.headers.get('x-hypdriv-cache')).toBeNull();
  });

  it('honours bypass rules', async () => {
    const h = harness({
      config: {
        cache: {
          edge: {
            policies: [
              {
                match: '/**',
                ttl: 60,
                includeRsc: false,
                bypass: {
                  cookies: ['session'],
                  headers: ['x-preview'],
                  query: ['draft'],
                  when: ({ url }) => url.pathname === '/when',
                },
              },
            ],
          },
        },
      },
    });
    const cases: Array<[string, RequestInit, string]> = [
      ['https://x.test/p', { headers: { cookie: 'a=1; session=abc' } }, 'cookie:session'],
      ['https://x.test/p', { headers: { 'x-preview': '1' } }, 'header:x-preview'],
      ['https://x.test/p?draft=1', {}, 'query:draft'],
      ['https://x.test/when', {}, 'when'],
      ['https://x.test/p', { headers: { 'cache-control': 'no-cache' } }, 'no-cache'],
      ['https://x.test/p', { headers: { pragma: 'no-cache' } }, 'no-cache'],
      ['https://x.test/p', { headers: { authorization: 'Bearer t' } }, 'authorization'],
      ['https://x.test/p', { headers: { rsc: '1' } }, 'rsc'],
    ];
    for (const [url, init, reason] of cases) {
      const r = await h.request(url, init);
      expect(r.decision, reason).toMatchObject({ status: 'BYPASS', reason });
      expect(r.response.headers.get('x-hypdriv-cache')).toBe('BYPASS');
      await r.flush();
    }
    // Nothing was stored: a clean request misses.
    const clean = await h.request('https://x.test/p');
    expect(clean.decision.status).toBe('MISS');
    expect(h.upstreamCalls).toHaveLength(cases.length + 1);
  });

  it('bypasses policies without any lifetime', async () => {
    const h = harness({ config: { cache: { edge: { policies: [{ match: '/**', ttl: 0 }] } } } });
    const r = await h.request('https://x.test/p');
    expect(r.decision).toMatchObject({ status: 'BYPASS', reason: 'zero-ttl' });
  });
});

describe('edge-cache stage: miss, hit, stale', () => {
  it('stores a miss and serves the next request from the cache with the documented headers', async () => {
    const h = harness();
    const miss = await h.request('https://x.test/blog/hello');
    expect(miss.decision).toMatchObject({ status: 'MISS', reason: 'store', key: expect.any(String) });
    expect(miss.response.headers.get('x-hypdriv-cache')).toBe('MISS');
    expect(miss.response.headers.get('x-hypdriv-cache-key')).toHaveLength(16);
    expect(miss.response.headers.get('cache-tag')).toBe('route:app:/blog/[slug],build:build-1');
    expect(miss.response.headers.get('surrogate-key')).toBe('route:app:/blog/[slug] build:build-1');
    expect(miss.response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=300',
    );
    expect(miss.response.headers.get('age')).toBeNull();
    expect(await text(miss.response)).toBe('body:0');
    await miss.flush();

    const hit = await h.request('https://x.test/blog/hello');
    expect(hit.decision).toMatchObject({
      status: 'HIT',
      reason: 'fresh',
      age: 0,
      tags: ['route:app:/blog/[slug]', 'build:build-1'],
    });
    expect(hit.shortCircuitedBy).toBe('edge-cache');
    expect(hit.response.headers.get('x-hypdriv-cache')).toBe('HIT');
    expect(hit.response.headers.get('age')).toBe('0');
    expect(hit.response.headers.get('content-type')).toBe('text/html');
    expect(hit.response.headers.get('cache-tag')).toBe('route:app:/blog/[slug],build:build-1');
    expect(await text(hit.response)).toBe('body:0');
    expect(h.upstreamCalls).toHaveLength(1);
    expect(hit.ctx.timings.list()).toContainEqual({ name: 'cache', desc: 'HIT' });

    h.advance(30_000);
    const later = await h.request('https://x.test/blog/hello');
    expect(later.response.headers.get('age')).toBe('30');
    // Other slugs are separate entries.
    const other = await h.request('https://x.test/blog/other');
    expect(other.decision.status).toBe('MISS');
  });

  it('serves HEAD requests from cache without a body and never stores HEAD misses', async () => {
    const h = harness();
    const headMiss = await h.request(
      'https://x.test/blog/a',
      { method: 'HEAD' },
      { next: () => new Response(null) },
    );
    expect(headMiss.decision).toMatchObject({ status: 'MISS', reason: 'uncacheable:head' });
    await headMiss.flush();
    const get = await h.request('https://x.test/blog/a');
    expect(get.decision.status).toBe('MISS');
    await get.flush();
    const head = await h.request('https://x.test/blog/a', { method: 'HEAD' });
    expect(head.decision.status).toBe('HIT');
    expect(head.response.body).toBeNull();
    expect(head.response.headers.get('content-type')).toBe('text/html');
  });

  it('serves stale within the SWR window and revalidates once in the background', async () => {
    const h = harness();
    await (await h.request('https://x.test/blog/a')).flush();
    h.advance(61_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      await gate;
      return new Response('body:1', { headers: { 'content-type': 'text/html' } });
    };
    const stale = await h.request('https://x.test/blog/a', {}, { next: slow });
    expect(stale.decision).toMatchObject({ status: 'STALE', reason: 'swr:revalidating', age: 61 });
    expect(stale.response.headers.get('x-hypdriv-cache')).toBe('STALE');
    expect(stale.response.headers.get('age')).toBe('61');
    expect(await text(stale.response)).toBe('body:0');
    // A concurrent stale request shares the in-flight revalidation.
    const second = await h.request('https://x.test/blog/a', {}, { next: slow });
    expect(second.decision.reason).toBe('swr:in-flight');
    release();
    await stale.flush();
    await second.flush();
    expect(h.upstreamCalls).toHaveLength(2);
    const revalidation = h.upstreamCalls[1]!;
    expect(revalidation.method).toBe('GET');
    expect(revalidation.headers.get('x-hypdriv-revalidate')).toBe('1');
    const fresh = await h.request('https://x.test/blog/a');
    expect(fresh.decision).toMatchObject({ status: 'HIT', age: 0 });
    expect(await text(fresh.response)).toBe('body:1');
  });

  it('serves stale without revalidating when the runner exposes no upstream', async () => {
    const h = harness();
    await (await h.request('https://x.test/blog/a')).flush();
    h.advance(61_000);
    const stale = await h.request('https://x.test/blog/a', {}, { runner: 'none' });
    expect(stale.decision).toMatchObject({ status: 'STALE', reason: 'swr:no-upstream' });
    await stale.flush();
    expect(h.upstreamCalls).toHaveLength(1);
  });

  it('keeps the stale entry when revalidation fails or returns something uncacheable', async () => {
    const h = harness();
    await (await h.request('https://x.test/blog/a')).flush();
    h.advance(61_000);
    const r1 = await h.request(
      'https://x.test/blog/a',
      {},
      { next: () => new Response('err', { status: 500 }) },
    );
    await r1.flush();
    const r2 = await h.request(
      'https://x.test/blog/a',
      {},
      {
        next: () => {
          throw new Error('boom');
        },
      },
    );
    await r2.flush();
    const still = await h.request('https://x.test/blog/a', {}, { runner: 'none' });
    expect(still.decision.status).toBe('STALE');
    expect(await text(still.response)).toBe('body:0');
  });

  it('ignores expired entries and misses again', async () => {
    const h = harness();
    await (await h.request('https://x.test/blog/a')).flush();
    h.advance(481_000);
    const r = await h.request('https://x.test/blog/a');
    expect(r.decision).toMatchObject({ status: 'MISS', reason: 'store' });
  });

  it('runs in the proxy runner too (not edgeOnly)', async () => {
    const h = harness();
    await (await h.request('https://x.test/blog/a', {}, { skipEdgeOnly: true })).flush();
    const hit = await h.request('https://x.test/blog/a', {}, { skipEdgeOnly: true });
    expect(hit.decision.status).toBe('HIT');
  });
});

describe('edge-cache stage: cacheability of upstream responses', () => {
  it('respects origin Cache-Control', async () => {
    const h = harness();
    const cases: Array<[string, string]> = [
      ['no-store', 'uncacheable:origin:no-store'],
      ['private, max-age=60', 'uncacheable:origin:private'],
      ['no-cache', 'uncacheable:origin:no-cache'],
      ['s-maxage=0', 'uncacheable:origin:max-age=0'],
    ];
    for (const [cc, reason] of cases) {
      const r = await h.request(
        'https://x.test/blog/a',
        {},
        { next: () => new Response('x', { headers: { 'cache-control': cc } }) },
      );
      expect(r.decision, cc).toMatchObject({ status: 'MISS', reason });
      expect(r.response.headers.get('cache-control')).toBe(cc);
      expect(r.response.headers.get('cache-tag')).toBeNull();
      await r.flush();
    }
    expect((await h.request('https://x.test/blog/a')).decision.reason).toBe('store');
  });

  it('caps the TTL at the origin max-age / s-maxage and honours must-revalidate', async () => {
    const h = harness();
    const r = await h.request(
      'https://x.test/blog/a',
      {},
      { next: () => new Response('x', { headers: { 'cache-control': 'public, s-maxage=10, max-age=5' } }) },
    );
    expect(r.response.headers.get('cache-control')).toBe('public, s-maxage=10, max-age=5');
    await r.flush();
    h.advance(9_000);
    expect((await h.request('https://x.test/blog/a')).decision.status).toBe('HIT');
    h.advance(2_000);
    expect((await h.request('https://x.test/blog/a', {}, { runner: 'none' })).decision.status).toBe('STALE');

    const strict = await h.request(
      'https://x.test/blog/b',
      {},
      { next: () => new Response('x', { headers: { 'cache-control': 'max-age=10, must-revalidate' } }) },
    );
    await strict.flush();
    h.advance(11_000);
    expect((await h.request('https://x.test/blog/b')).decision.status).toBe('MISS');
  });

  it('ignores origin Cache-Control when respectOrigin is off', async () => {
    const h = harness({
      config: { cache: { edge: { policies: [{ match: '/**', ttl: 60, respectOrigin: false }] } } },
    });
    const r = await h.request(
      'https://x.test/p',
      {},
      { next: () => new Response('x', { headers: { 'cache-control': 'private, no-store' } }) },
    );
    expect(r.decision.reason).toBe('store');
    await r.flush();
    expect((await h.request('https://x.test/p')).decision.status).toBe('HIT');
  });

  it('never stores responses with Set-Cookie, Vary: *, unlisted statuses or oversized bodies', async () => {
    const h = harness({
      config: { cache: { edge: { policies: [{ match: '/**', ttl: 60 }], maxBodySize: 10 } } },
    });
    const cookie = await h.request(
      'https://x.test/a',
      {},
      { next: () => new Response('x', { headers: { 'set-cookie': 's=1' } }) },
    );
    expect(cookie.decision.reason).toBe('uncacheable:set-cookie');
    expect(cookie.response.headers.get('set-cookie')).toBe('s=1');
    const vary = await h.request(
      'https://x.test/b',
      {},
      { next: () => new Response('x', { headers: { vary: '*' } }) },
    );
    expect(vary.decision.reason).toBe('uncacheable:vary');
    const status = await h.request(
      'https://x.test/c',
      {},
      { next: () => new Response('x', { status: 302, headers: { location: '/d' } }) },
    );
    expect(status.decision.reason).toBe('uncacheable:status:302');
    const declared = await h.request(
      'https://x.test/d',
      {},
      { next: () => new Response('x'.repeat(50), { headers: { 'content-length': '50' } }) },
    );
    expect(declared.decision.reason).toBe('uncacheable:too-large');
    const streamed = await h.request('https://x.test/e', {}, { next: () => new Response('y'.repeat(50)) });
    expect(streamed.decision.reason).toBe('store');
    expect(await text(streamed.response)).toBe('y'.repeat(50));
    await streamed.flush();
    expect((await h.request('https://x.test/e')).decision.status).toBe('MISS');
  });

  it('negative-caches 404/410 with negativeTtl', async () => {
    const h = harness({
      config: { cache: { edge: { policies: [{ match: '/**', ttl: 60, swr: 60 }], negativeTtl: 5 } } },
    });
    const miss = await h.request(
      'https://x.test/nope',
      {},
      { next: () => new Response('nf', { status: 404 }) },
    );
    expect(miss.decision).toMatchObject({ status: 'MISS', reason: 'store:negative' });
    await miss.flush();
    const neg = await h.request('https://x.test/nope');
    expect(neg.decision).toMatchObject({ status: 'NEGATIVE', reason: 'negative' });
    expect(neg.response.status).toBe(404);
    expect(neg.response.headers.get('x-hypdriv-cache')).toBe('NEGATIVE');
    expect(h.upstreamCalls).toHaveLength(1);
    h.advance(6_000);
    expect((await h.request('https://x.test/nope')).decision.status).toBe('MISS');

    const off = harness({
      config: { cache: { edge: { policies: [{ match: '/**', ttl: 60 }], negativeTtl: 0 } } },
    });
    const r = await off.request(
      'https://x.test/nope',
      {},
      { next: () => new Response('nf', { status: 410 }) },
    );
    expect(r.decision.reason).toBe('uncacheable:negative-disabled');
  });

  it('emits Vary for varied request headers and keeps variants apart', async () => {
    const h = harness({
      config: {
        cache: {
          edge: {
            policies: [{ match: '/**', ttl: 60, vary: { headers: ['accept-language'], device: true } }],
          },
        },
      },
    });
    const en = await h.request('https://x.test/p', { headers: { 'accept-language': 'en' } });
    expect(en.response.headers.get('vary')).toBe('accept-language, sec-ch-ua-mobile');
    await en.flush();
    const de = await h.request('https://x.test/p', { headers: { 'accept-language': 'de' } });
    expect(de.decision.status).toBe('MISS');
    await de.flush();
    const enHit = await h.request('https://x.test/p', { headers: { 'accept-language': 'en' } });
    expect(enHit.decision.status).toBe('HIT');
    expect(enHit.response.headers.get('vary')).toBe('accept-language, sec-ch-ua-mobile');
    const mobile = await h.request('https://x.test/p', {
      headers: { 'accept-language': 'en', 'sec-ch-ua-mobile': '?1' },
    });
    expect(mobile.decision.status).toBe('MISS');
  });

  it('uses geo, flag and locale dimensions', async () => {
    const h = harness({
      config: {
        cache: {
          edge: {
            policies: [
              { match: '/**', ttl: 60, vary: { geo: ['country'], flags: ['beta'], language: true } },
            ],
          },
        },
      },
      resolvers: {
        flags: (ctx) => (ctx.request.headers.get('x-test-beta') ? { beta: true } : { beta: false }),
      },
    });
    await (await h.request('https://x.test/p', {}, { cf: { country: 'US' } })).flush();
    expect((await h.request('https://x.test/p', {}, { cf: { country: 'US' } })).decision.status).toBe('HIT');
    expect((await h.request('https://x.test/p', {}, { cf: { country: 'DE' } })).decision.status).toBe('MISS');
    expect(
      (await h.request('https://x.test/p', { headers: { 'x-test-beta': '1' } }, { cf: { country: 'US' } }))
        .decision.status,
    ).toBe('MISS');
    expect(
      (
        await h.request(
          'https://x.test/p',
          { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } },
          { cf: { country: 'US' } },
        )
      ).decision.status,
    ).toBe('MISS');
  });

  it('can switch off tag and debug headers while still recording the decision', async () => {
    const h = harness({
      config: {
        cache: { edge: { policies: [{ match: '/**', ttl: 60 }], emitTagHeaders: false, debugHeader: false } },
      },
    });
    const r = await h.request('https://x.test/p');
    expect(r.response.headers.get('x-hypdriv-cache')).toBeNull();
    expect(r.response.headers.get('cache-tag')).toBeNull();
    expect(r.decision.status).toBe('MISS');
    expect(r.ctx.timings.list()).toContainEqual({ name: 'cache', desc: 'MISS' });
  });
});

describe('edge-cache stage: stale-if-error', () => {
  async function seeded(h: ReturnType<typeof harness>) {
    await (await h.request('https://x.test/blog/a')).flush();
    h.advance(200_000); // past ttl + swr (180 s), inside stale-if-error (480 s)
  }

  it('serves the stale entry when the upstream answers 5xx', async () => {
    const h = harness();
    await seeded(h);
    const r = await h.request(
      'https://x.test/blog/a',
      {},
      { next: () => new Response('down', { status: 503 }) },
    );
    expect(r.decision).toMatchObject({ status: 'ERROR-STALE', reason: 'upstream:503', age: 200 });
    expect(r.response.status).toBe(200);
    expect(r.response.headers.get('x-hypdriv-cache')).toBe('ERROR-STALE');
    expect(r.response.headers.get('age')).toBe('200');
    expect(await text(r.response)).toBe('body:0');
  });

  it('serves the stale entry when the upstream throws and the runner routes next through UPSTREAM_KEY', async () => {
    const h = harness();
    await seeded(h);
    const r = await h.request(
      'https://x.test/blog/a',
      {},
      {
        next: () => {
          throw new Error('render failed');
        },
      },
    );
    expect(r.decision).toMatchObject({ status: 'ERROR-STALE', reason: 'upstream:error' });
    expect(await text(r.response)).toBe('body:0');
  });

  it('offers recover() to runners that call next directly', async () => {
    const h = harness();
    await seeded(h);
    const ctx = makeCtx(new Request('https://x.test/blog/a'), {
      config: { cache: { edge: { inferredStatic: { ttl: 60, swr: 120, staleIfError: 300 } } } },
      manifest,
    });
    await expect(
      runPipeline({
        stages: [h.edgeCache.stage()],
        ctx,
        next: async () => {
          throw new Error('render failed');
        },
      }),
    ).rejects.toThrow('render failed');
    const recovered = h.edgeCache.recover(ctx);
    expect(recovered?.headers.get('x-hypdriv-cache')).toBe('ERROR-STALE');
    expect(await recovered!.text()).toBe('body:0');
    expect(h.edgeCache.recover(ctx)).toBeUndefined();
    expect(h.edgeCache.recover(makeCtx('https://x.test/other', { manifest }))).toBeUndefined();
  });

  it('passes errors through when no stale entry exists', async () => {
    const h = harness();
    const r = await h.request(
      'https://x.test/blog/a',
      {},
      { next: () => new Response('down', { status: 502 }) },
    );
    expect(r.response.status).toBe(502);
    expect(r.decision).toMatchObject({ status: 'MISS', reason: 'uncacheable:status:502' });
    await expect(
      h.request(
        'https://x.test/blog/b',
        {},
        {
          next: () => {
            throw new Error('boom');
          },
        },
      ),
    ).rejects.toThrow('boom');
  });
});

describe('edge-cache stage: coalescing', () => {
  function gate() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release, opened };
  }

  it('shares one upstream render between concurrent misses for the same key', async () => {
    const h = harness();
    const g = gate();
    const next = async () => {
      await g.opened;
      return new Response('rendered', { headers: { 'content-type': 'text/html' } });
    };
    const leader = h.request('https://x.test/blog/a', {}, { next });
    await new Promise((r) => setTimeout(r, 5));
    const follower = h.request('https://x.test/blog/a', {}, { next });
    const other = h.request('https://x.test/blog/b', {}, { next });
    await new Promise((r) => setTimeout(r, 5));
    g.release();
    const [l, f, o] = await Promise.all([leader, follower, other]);
    expect(l.decision).toMatchObject({ status: 'MISS', reason: 'store' });
    expect(f.decision).toMatchObject({ status: 'HIT', reason: 'coalesced', age: 0 });
    expect(f.shortCircuitedBy).toBe('edge-cache');
    expect(f.response.headers.get('x-hypdriv-cache')).toBe('HIT');
    expect(f.response.headers.get('content-type')).toBe('text/html');
    expect(await text(f.response)).toBe('rendered');
    expect(await text(l.response)).toBe('rendered');
    expect(o.decision.status).toBe('MISS');
    expect(h.upstreamCalls).toHaveLength(2);
    await l.flush();
    expect((await h.request('https://x.test/blog/a')).decision.status).toBe('HIT');
  });

  it('lets followers render themselves when the leader response is not cacheable or the leader throws', async () => {
    const h = harness();
    const g = gate();
    const uncacheable = async () => {
      await g.opened;
      return new Response('private', { headers: { 'set-cookie': 's=1' } });
    };
    const leader = h.request('https://x.test/blog/a', {}, { next: uncacheable });
    await new Promise((r) => setTimeout(r, 5));
    const follower = h.request('https://x.test/blog/a', {}, { next: async () => new Response('own') });
    await new Promise((r) => setTimeout(r, 5));
    g.release();
    const [l, f] = await Promise.all([leader, follower]);
    expect(l.decision.reason).toBe('uncacheable:set-cookie');
    expect(f.decision.status).toBe('MISS');
    expect(await text(f.response)).toBe('own');
    expect(h.upstreamCalls).toHaveLength(2);

    const g2 = gate();
    const throwing = async () => {
      await g2.opened;
      throw new Error('leader failed');
    };
    const leader2 = h.request('https://x.test/blog/c', {}, { next: throwing });
    await new Promise((r) => setTimeout(r, 5));
    const follower2 = h.request('https://x.test/blog/c', {}, { next: async () => new Response('own2') });
    await new Promise((r) => setTimeout(r, 5));
    g2.release();
    await expect(leader2).rejects.toThrow('leader failed');
    const f2 = await follower2;
    expect(f2.decision).toMatchObject({ status: 'MISS', reason: 'store' });
    expect(await text(f2.response)).toBe('own2');
  });

  it('times out waiting for a silent leader', async () => {
    const h = harness({ coalesceTimeoutMs: 20 });
    const never = new Promise<Response>(() => {});
    void h.request('https://x.test/blog/a', {}, { next: () => never, runner: 'direct' });
    await new Promise((r) => setTimeout(r, 5));
    const follower = await h.request(
      'https://x.test/blog/a',
      {},
      { next: async () => new Response('fallback') },
    );
    expect(follower.decision).toMatchObject({ status: 'MISS', reason: 'store' });
    expect(await text(follower.response)).toBe('fallback');
  });
});

describe('edge-cache purge', () => {
  function recordingPurger() {
    const calls: Array<{ kind: string; values: string[] }> = [];
    const purger: Purger = {
      async purgeTags(tags) {
        calls.push({ kind: 'tags', values: tags });
      },
      async purgeUrls(urls) {
        calls.push({ kind: 'urls', values: urls });
      },
    };
    return { calls, purger };
  }

  it('purges by tag through the index and the purger', async () => {
    const { calls, purger } = recordingPurger();
    const h = harness({ tagIndex: createMemoryTagIndex(), purger });
    await (await h.request('https://x.test/blog/a')).flush();
    await (await h.request('https://x.test/blog/b')).flush();
    await (await h.request('https://x.test/search')).flush();
    expect(await h.edgeCache.purgeTags(['route:app:/blog/[slug]'])).toBe(2);
    expect(calls).toEqual([{ kind: 'tags', values: ['route:app:/blog/[slug]'] }]);
    expect((await h.request('https://x.test/blog/a')).decision.status).toBe('MISS');
    expect((await h.request('https://x.test/search')).decision.status).toBe('HIT');
    expect(await h.edgeCache.purgeTags(['search', 'search'])).toBe(1);
    // Build tags are never indexed (one write per miss would hammer the index), only forwarded to the purger.
    expect(await h.edgeCache.purgeTags(['build:build-1'])).toBe(0);
    expect(calls[2]).toEqual({ kind: 'tags', values: ['build:build-1'] });
    expect(await h.edgeCache.purgeTags([])).toBe(0);
  });

  it('purges URLs by rebuilding the base key, resolving relative paths against the learned origin', async () => {
    const { calls, purger } = recordingPurger();
    const h = harness({ purger });
    await (await h.request('https://x.test/blog/a?utm_source=x')).flush();
    await (await h.request('https://x.test/search')).flush();
    expect(await h.edgeCache.purgeUrls(['/blog/a', 'https://x.test/search', 'https://x.test/account'])).toBe(
      2,
    );
    expect(calls).toEqual([
      { kind: 'urls', values: ['https://x.test/blog/a', 'https://x.test/search', 'https://x.test/account'] },
    ]);
    expect((await h.request('https://x.test/blog/a')).decision.status).toBe('MISS');
    expect((await h.request('https://x.test/search')).decision.status).toBe('MISS');
  });

  it('purgeUrls works without any request when config and manifest are given', async () => {
    const store = createMemoryStore();
    const config = { cache: { edge: { inferredStatic: { ttl: 60 } } } } satisfies HypDrivConfig;
    const h = harness({ store, config });
    await (await h.request('https://x.test/blog/a')).flush();
    const fresh = createEdgeCache({
      store,
      config: makeCtx('https://x.test/', { config, manifest }).config,
      manifest,
    });
    expect(await fresh.purgeUrls(['https://x.test/blog/a'])).toBe(1);
    expect((await h.request('https://x.test/blog/a')).decision.status).toBe('MISS');
    const blind = createEdgeCache({ store: createMemoryStore() });
    expect(await blind.purgeUrls(['/relative'])).toBe(0);
  });
});

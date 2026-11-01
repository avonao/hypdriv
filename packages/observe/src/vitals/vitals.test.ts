import { describe, expect, it, vi } from 'vitest';
import { normalizeVitalsPayload, rateVital, vitalsHandler } from './handler';
import { analyticsEngineVitalsSink, functionVitalsSink, logVitalsSink, multiVitalsSink } from './sinks';
import type { VitalsContext, VitalsPayload, VitalsSink } from './types';

const NOW = 1_700_000_000_000;

function recordingSink() {
  const writes: Array<{ payload: VitalsPayload; ctx: VitalsContext }> = [];
  const sink: VitalsSink = {
    write(payload, ctx) {
      writes.push({ payload, ctx });
    },
  };
  return { writes, sink };
}

const metric = (partial: Record<string, unknown> = {}) => ({
  name: 'LCP',
  value: 1234.5,
  rating: 'good',
  id: 'v4-1',
  pathname: '/blog/x',
  navigationType: 'navigate',
  route: 'app:/blog/[slug]',
  buildId: 'b1',
  cache: 'HIT',
  ts: NOW - 10,
  ...partial,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x.test/_hypdriv/vitals', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'cf-connecting-ip': '203.0.113.9',
      'cf-ipcountry': 'US',
      ...headers,
    },
  });

describe('normalizeVitalsPayload', () => {
  it('accepts valid payloads, bounds strings and keeps extra primitives', () => {
    const p = normalizeVitalsPayload(
      metric({
        delta: 5,
        extra: 'yes',
        nested: { a: 1 },
        long: 'x'.repeat(500),
        __proto__: { hacked: true },
      }),
      NOW,
    )!;
    expect(p).toMatchObject({
      name: 'LCP',
      value: 1234.5,
      rating: 'good',
      id: 'v4-1',
      pathname: '/blog/x',
      route: 'app:/blog/[slug]',
      buildId: 'b1',
      cache: 'HIT',
      ts: NOW - 10,
      delta: 5,
      extra: 'yes',
    });
    expect(p.nested).toBeUndefined();
    expect((p.long as string).length).toBe(256);
    expect(Object.hasOwn(p, 'hacked')).toBe(false);
  });
  it('derives missing ratings and timestamps and rejects junk', () => {
    expect(normalizeVitalsPayload(metric({ rating: undefined, value: 3000, ts: 'x' }), NOW)).toMatchObject({
      rating: 'needs-improvement',
      ts: NOW,
    });
    expect(normalizeVitalsPayload(metric({ name: 'inp', value: 600, rating: 'bogus' }), NOW)).toMatchObject({
      name: 'INP',
      rating: 'poor',
    });
    expect(normalizeVitalsPayload(metric({ name: 'FID' }))).toBeNull();
    expect(normalizeVitalsPayload(metric({ value: -1 }))).toBeNull();
    expect(normalizeVitalsPayload(metric({ value: 'NaN' }))).toBeNull();
    expect(normalizeVitalsPayload(metric({ id: '' }))).toBeNull();
    expect(normalizeVitalsPayload(metric({ pathname: 'blog' }))).toBeNull();
    expect(normalizeVitalsPayload(null)).toBeNull();
    expect(normalizeVitalsPayload([metric()])).toBeNull();
    expect(
      normalizeVitalsPayload(
        metric({ attribution: { element: 'img', ['__proto__']: 1, long: 'y'.repeat(5000) } }),
      )!.attribution,
    ).toEqual({ element: 'img', long: 'y'.repeat(2048) });
    expect(rateVital('CLS', 0.05)).toBe('good');
    expect(rateVital('CLS', 0.2)).toBe('needs-improvement');
    expect(rateVital('TTFB', 5000)).toBe('poor');
  });
});

describe('vitalsHandler', () => {
  it('accepts single and batched beacons (text/plain), writes with request context and answers 204 no-store', async () => {
    const { writes, sink } = recordingSink();
    const handler = vitalsHandler({ sink, now: () => NOW });
    const single = await handler(post(metric()));
    expect(single.status).toBe(204);
    expect(single.headers.get('cache-control')).toBe('no-store');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.ctx).toEqual({ ip: '203.0.113.9', country: 'US', ua: undefined });
    const batch = await handler(
      post([metric({ name: 'CLS', value: 0.01 }), metric({ name: 'INP', value: 50 }), { junk: true }]),
      { ip: '10.0.0.1', country: 'DE' },
    );
    expect(batch.status).toBe(204);
    expect(writes).toHaveLength(3);
    expect(writes[1]!.ctx).toMatchObject({ ip: '10.0.0.1', country: 'DE' });
    expect(writes.map((w) => w.payload.name)).toEqual(['LCP', 'CLS', 'INP']);
  });

  it('rejects wrong methods, oversized and invalid bodies', async () => {
    const { writes, sink } = recordingSink();
    const handler = vitalsHandler({ sink, maxBytes: 2000, maxMetrics: 2 });
    expect((await handler(new Request('https://x.test/v'))).status).toBe(405);
    expect((await handler(new Request('https://x.test/v'))).headers.get('allow')).toBe('POST, OPTIONS');
    expect((await handler(post('x'.repeat(2001)))).status).toBe(413);
    expect((await handler(post('{}', { 'content-length': '5000' }))).status).toBe(413);
    expect((await handler(post('{not json'))).status).toBe(400);
    expect((await handler(post([]))).status).toBe(400);
    expect((await handler(post([{ junk: 1 }]))).status).toBe(400);
    expect((await handler(post([metric(), metric(), metric()]))).status).toBe(400);
    const empty = await handler(new Request('https://x.test/v', { method: 'POST' }));
    expect(empty.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('samples per beacon and survives sink failures', async () => {
    const { writes, sink } = recordingSink();
    let r = 0.9;
    const handler = vitalsHandler({ sink, sampleRate: 0.5, random: () => r });
    expect((await handler(post([metric(), metric({ name: 'FCP' })]))).status).toBe(204);
    expect(writes).toHaveLength(0);
    r = 0.1;
    await handler(post([metric(), metric({ name: 'FCP' })]));
    expect(writes).toHaveLength(2);
    const warn = vi.fn();
    const log = {
      level: 'warn' as const,
      debug() {},
      info() {},
      warn,
      error() {},
      child() {
        return log;
      },
    };
    const failing = vitalsHandler({
      sink: {
        write: () => {
          throw new Error('ae down');
        },
      },
      log,
    });
    expect((await failing(post(metric()))).status).toBe(204);
    expect(warn).toHaveBeenCalledWith('vitals: sink failed', { error: 'ae down', metric: 'LCP' });
  });

  it('handles CORS preflight and origin allow-lists', async () => {
    const { sink } = recordingSink();
    const any = vitalsHandler({ sink, allowOrigin: '*' });
    const pre = await any(
      new Request('https://x.test/v', { method: 'OPTIONS', headers: { origin: 'https://app.test' } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type');
    const listed = vitalsHandler({ sink, allowOrigin: 'https://app.test, https://admin.test' });
    const ok = await listed(post(metric(), { origin: 'https://admin.test' }));
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://admin.test');
    expect(ok.headers.get('vary')).toBe('Origin');
    const denied = await listed(post(metric(), { origin: 'https://evil.test' }));
    expect(denied.status).toBe(204);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const noCors = vitalsHandler({ sink });
    const plain = await noCors(new Request('https://x.test/v', { method: 'OPTIONS' }));
    expect(plain.status).toBe(204);
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('sinks', () => {
  it('logs one line per metric without the ip', () => {
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    const log = {
      level: 'info' as const,
      debug() {},
      info: (m: string, f?: Record<string, unknown>) => void lines.push([m, f]),
      warn() {},
      error() {},
      child() {
        return log;
      },
    };
    const p = normalizeVitalsPayload(metric({ attribution: { element: 'img' } }), NOW)!;
    logVitalsSink(log).write(p, { ip: '1.2.3.4', country: 'US' });
    expect(lines).toEqual([
      [
        'vitals',
        {
          name: 'LCP',
          value: 1234.5,
          rating: 'good',
          id: 'v4-1',
          pathname: '/blog/x',
          navigationType: 'navigate',
          route: 'app:/blog/[slug]',
          buildId: 'b1',
          cache: 'HIT',
          ts: NOW - 10,
          attribution: { element: 'img' },
          country: 'US',
        },
      ],
    ]);
  });

  it('writes Analytics Engine data points with the documented layout', () => {
    const points: unknown[] = [];
    const sink = analyticsEngineVitalsSink({ writeDataPoint: (p) => void points.push(p) });
    const p = normalizeVitalsPayload(metric(), NOW)!;
    sink.write(p, { country: 'US' });
    sink.write(
      { ...p, route: undefined, navigationType: undefined, buildId: undefined, cache: undefined },
      {},
    );
    expect(points).toEqual([
      {
        indexes: ['app:/blog/[slug]'],
        blobs: ['LCP', 'good', '/blog/x', 'navigate', 'b1', 'HIT', 'US', ''],
        doubles: [1234.5, NOW - 10],
      },
      {
        indexes: ['/blog/x'],
        blobs: ['LCP', 'good', '/blog/x', '', '', '', '', ''],
        doubles: [1234.5, NOW - 10],
      },
    ]);
  });

  it('stores the experiment tag next to the measurement', () => {
    const points: Array<{ blobs?: Array<string | null> }> = [];
    const sink = analyticsEngineVitalsSink({ writeDataPoint: (p) => void points.push(p) });
    sink.write({ ...normalizeVitalsPayload(metric(), NOW)!, experiments: '|checkout:b|' }, {});
    expect(points[0]?.blobs?.[7]).toBe('|checkout:b|');
  });

  it('fans out and wraps functions', async () => {
    const a = recordingSink();
    const calls: string[] = [];
    const fn = functionVitalsSink((p) => void calls.push(p.name));
    const multi = multiVitalsSink([
      a.sink,
      {
        write: () => {
          throw new Error('x');
        },
      },
      fn,
    ]);
    await multi.write(normalizeVitalsPayload(metric(), NOW)!, {});
    expect(a.writes).toHaveLength(1);
    expect(calls).toEqual(['LCP']);
  });
});

describe('vitalsHandler with experiments', () => {
  const post = (cookie: string | undefined, body: unknown) =>
    new Request('https://example.com/_hypdriv/vitals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it('tags measurements with the visitor’s variants from the cookie, whatever the body claims', async () => {
    const { writes, sink } = recordingSink();
    const handler = vitalsHandler({ sink, now: () => NOW, experimentCookie: 'hyp_exp' });
    const forged = metric({ experiments: '|checkout:control|' });
    await handler(post('hyp_exp=hero%3Ab*.checkout%3Ab', [forged]));
    expect(writes[0]?.payload.experiments).toBe('|checkout:b|hero:b|');
    await handler(post(undefined, [forged]));
    expect(writes[1]?.payload.experiments).toBeUndefined();
    await handler(post('hyp_exp=garbage', [metric()]));
    expect(writes[2]?.payload.experiments).toBeUndefined();
  });

  it('reports the page of a prerender activation once, before sampling, and adds the cookie it returns', async () => {
    const { writes, sink } = recordingSink();
    const activations: Array<{ pathname: string; cookie: string | null }> = [];
    const handler = vitalsHandler({
      sink,
      now: () => NOW,
      sampleRate: 0,
      experimentCookie: 'hyp_exp',
      onPrerenderActivation: ({ request, pathname }) => {
        activations.push({ pathname, cookie: request.headers.get('cookie') });
        return 'hyp_exp=checkout%3Ab*; Path=/; HttpOnly';
      },
    });
    const res = await handler(
      post('hyp_exp=checkout%3Ab', [
        metric({ name: 'TTFB', navigationType: 'prerender', pathname: '/checkout/pay' }),
        metric({ name: 'LCP', navigationType: 'prerender', pathname: '/checkout/pay' }),
      ]),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBe('hyp_exp=checkout%3Ab*; Path=/; HttpOnly');
    expect(activations).toEqual([{ pathname: '/checkout/pay', cookie: 'hyp_exp=checkout%3Ab' }]);
    // The sample rate is 0: no vitals are stored, but the activation was still seen.
    expect(writes).toHaveLength(0);
    const plain = await handler(post(undefined, [metric({ navigationType: 'navigate' })]));
    expect(plain.headers.get('set-cookie')).toBeNull();
    expect(activations).toHaveLength(1);
  });

  it('survives a failing activation hook', async () => {
    const { writes, sink } = recordingSink();
    const warnings: string[] = [];
    const handler = vitalsHandler({
      sink,
      now: () => NOW,
      onPrerenderActivation: () => {
        throw new Error('provider down');
      },
      log: { warn: (message: string) => warnings.push(message) } as never,
    });
    const res = await handler(post(undefined, [metric({ navigationType: 'prerender' })]));
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(writes).toHaveLength(1);
    expect(warnings).toEqual(['vitals: prerender activation failed']);
  });

  it('leaves the payload alone without a configured cookie', async () => {
    const { writes, sink } = recordingSink();
    await vitalsHandler({ sink, now: () => NOW })(post('hyp_exp=checkout%3Ab', [metric()]));
    expect(writes[0]?.payload.experiments).toBeUndefined();
  });
});

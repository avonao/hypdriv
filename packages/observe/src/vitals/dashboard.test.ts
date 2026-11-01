import { describe, expect, it, vi } from 'vitest';
import { renderVitalsDashboard } from './dashboard';
import { memoryVitals } from './memory';
import {
  AnalyticsEngineQueryError,
  analyticsEngineVitalsSource,
  cachedVitalsSource,
  queryAnalyticsEngine,
  vitalsDistributionSql,
  vitalsOverallSql,
  vitalsSql,
  vitalsTrendSql,
} from './query';
import {
  buildVitalsSnapshot,
  formatVital,
  parseBucketTime,
  trendBucketSeconds,
  weightedQuantile,
} from './stats';
import type { VitalName, VitalsPayload, VitalsSnapshot, VitalsSource } from './types';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const DAY = 86_400_000;

const payload = (name: VitalName, value: number, extra: Partial<VitalsPayload> = {}): VitalsPayload => ({
  name,
  value,
  rating: 'good',
  id: `id-${name}-${value}`,
  pathname: '/',
  ts: NOW,
  ...extra,
});

describe('stats', () => {
  it('computes weighted quantiles', () => {
    expect(weightedQuantile([], 0.75)).toBeNaN();
    expect(weightedQuantile([{ value: 5, weight: 1 }], 0.75)).toBe(5);
    const four = [1, 2, 3, 4].map((value) => ({ value, weight: 1 }));
    expect(weightedQuantile(four, 0.5)).toBe(2);
    expect(weightedQuantile(four, 0.75)).toBe(3);
    // A heavy sample dominates, however it is ordered.
    expect(
      weightedQuantile(
        [
          { value: 900, weight: 1 },
          { value: 100, weight: 10 },
        ],
        0.75,
      ),
    ).toBe(100);
    expect(weightedQuantile([{ value: 3, weight: 0 }], 0.5)).toBeNaN();
  });

  it('formats values by metric', () => {
    expect(formatVital('LCP', 842.4)).toBe('842 ms');
    expect(formatVital('LCP', 2450)).toBe('2.45 s');
    expect(formatVital('TTFB', 12_400)).toBe('12.4 s');
    expect(formatVital('CLS', 0.0234)).toBe('0.023');
    expect(formatVital('CLS', Number.NaN)).toBe('—');
  });

  it('parses Analytics Engine bucket timestamps', () => {
    expect(parseBucketTime('2026-10-31 06:00:00')).toBe(Date.parse('2026-10-31T06:00:00Z'));
    expect(parseBucketTime('2026-10-31T06:00:00Z')).toBe(Date.parse('2026-10-31T06:00:00Z'));
    expect(parseBucketTime(1_793_000_000)).toBe(1_793_000_000_000);
    expect(parseBucketTime('1793000000')).toBe(1_793_000_000_000);
    expect(parseBucketTime(1_793_000_000_000)).toBe(1_793_000_000_000);
    expect(parseBucketTime(null)).toBeNaN();
  });

  it('picks the trend bucket from the window', () => {
    expect([1, 2, 3, 7, 8, 30].map(trendBucketSeconds)).toEqual([3600, 3600, 21_600, 21_600, 86_400, 86_400]);
  });

  it('builds a snapshot, dropping unusable rows and unknown metrics', () => {
    const snapshot = buildVitalsSnapshot(
      {
        overall: [
          { metric: 'INP', p75: '180', p50: 90, samples: '50' },
          { metric: 'LCP', p75: 3000, p50: 2000, samples: 120 },
          { metric: 'FOO', p75: 1, p50: 1, samples: 1 },
          { metric: 'CLS', p75: 'nope', p50: 0, samples: 3 },
        ],
        routes: [
          { route: '/a', metric: 'LCP', p75: 1000, p50: 800, samples: 10 },
          { route: '/b', metric: 'LCP', p75: 5000, p50: 4000, samples: 30 },
          { route: '/b', metric: 'INP', p75: 100, p50: 50, samples: 28 },
          { route: '', metric: 'LCP', p75: 1, p50: 1, samples: 1 },
          { route: 7, metric: 'LCP', p75: 1, p50: 1, samples: 1 },
        ],
        trend: [
          { bucket: '2026-10-31 06:00:00', metric: 'LCP', p75: 2900, samples: 10 },
          { bucket: '2026-10-31 00:00:00', metric: 'LCP', p75: 3100, samples: 12 },
          { bucket: 'garbage', metric: 'LCP', p75: 1, samples: 1 },
        ],
        distribution: [
          { metric: 'LCP', rating: 'good', samples: 60 },
          { metric: 'LCP', rating: 'poor', samples: 20 },
          { metric: 'LCP', rating: 'bogus', samples: 99 },
          { metric: 'LCP', rating: 'needs-improvement', samples: 0 },
        ],
      },
      {
        source: { kind: 'analytics-engine', label: 'ds', partial: false },
        days: 7,
        now: NOW,
        bucketSeconds: 21_600,
      },
    );
    expect(snapshot.overall.map((o) => o.name)).toEqual(['LCP', 'INP']);
    expect(snapshot.overall[0]).toMatchObject({
      name: 'LCP',
      p75: 3000,
      rating: 'needs-improvement',
      distribution: { good: 60, 'needs-improvement': 0, poor: 20 },
    });
    expect(snapshot.overall[1]).toMatchObject({ p75: 180, rating: 'good' });
    expect(snapshot.routes.map((r) => r.route)).toEqual(['/b', '/a']);
    expect(snapshot.routes[0]).toMatchObject({
      samples: 30,
      metrics: { LCP: { rating: 'poor' }, INP: { rating: 'good' } },
    });
    expect(snapshot.trend.map((t) => t.t)).toEqual([
      Date.parse('2026-10-31T00:00:00Z'),
      Date.parse('2026-10-31T06:00:00Z'),
    ]);
    expect(snapshot.route).toBeNull();
    expect(snapshot.generatedAt).toBe(NOW);
  });

  it('keeps the most measured routes only', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      route: `/r${i}`,
      metric: 'LCP',
      p75: 1,
      p50: 1,
      samples: i + 1,
    }));
    const snapshot = buildVitalsSnapshot(
      { overall: [], routes: rows, trend: [], distribution: [] },
      {
        source: { kind: 'memory', label: 'm', partial: true },
        days: 1,
        now: NOW,
        bucketSeconds: 3600,
        maxRoutes: 5,
      },
    );
    expect(snapshot.routes.map((r) => r.route)).toEqual(['/r59', '/r58', '/r57', '/r56', '/r55']);
  });
});

describe('Analytics Engine SQL', () => {
  it('shares one filter across the queries and escapes the route', () => {
    for (const sql of [
      vitalsSql('ds', { days: 3, route: "/a'b\\c" }),
      vitalsOverallSql('ds', { days: 3, route: "/a'b\\c" }),
      vitalsDistributionSql('ds', { days: 3, route: "/a'b\\c" }),
      vitalsTrendSql('ds', { days: 3, route: "/a'b\\c" }),
    ]) {
      expect(sql).toContain('FROM ds');
      expect(sql).toContain("INTERVAL '3' DAY");
      expect(sql).toContain("blob1 IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')");
      expect(sql).toContain("index1 = '/a\\'b\\\\c'");
      expect(sql.endsWith('FORMAT JSON')).toBe(true);
    }
    expect(vitalsOverallSql('ds', { days: 1 })).toContain('GROUP BY metric');
    expect(vitalsDistributionSql('ds', { days: 1 })).toContain('GROUP BY metric, rating');
  });

  it('clamps the window and rejects dataset names that are not identifiers', () => {
    expect(vitalsSql('ds', { days: 500 })).toContain("INTERVAL '90' DAY");
    expect(vitalsSql('ds', { days: 0 })).toContain("INTERVAL '1' DAY");
    for (const bad of ['a b', 'x;DROP', '', 'a-b'])
      expect(() => vitalsSql(bad, { days: 1 })).toThrow(/invalid Analytics Engine dataset/);
  });

  it('buckets the trend by hour, six hours or day', () => {
    expect(vitalsTrendSql('ds', { days: 1 })).toContain("toStartOfInterval(timestamp, INTERVAL '1' HOUR)");
    expect(vitalsTrendSql('ds', { days: 7 })).toContain("toStartOfInterval(timestamp, INTERVAL '6' HOUR)");
    expect(vitalsTrendSql('ds', { days: 30 })).toContain("toStartOfInterval(timestamp, INTERVAL '1' DAY)");
    expect(vitalsTrendSql('ds', { days: 30, bucketSeconds: 900 })).toContain("INTERVAL '15' MINUTE");
  });
});

function fakeFetch(handler: (sql: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; sql: string; headers: Headers }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const sql = String(init?.body ?? '');
    calls.push({ url: String(input), sql, headers: new Headers(init?.headers) });
    return handler(sql, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const rows = (data: unknown[]) => new Response(JSON.stringify({ meta: [], data, rows: data.length }));

describe('queryAnalyticsEngine()', () => {
  const base = { accountId: 'acc123', apiToken: 'secret-token', sql: 'SELECT 1' };

  it('posts the SQL with the bearer token and returns the data rows', async () => {
    const { fetch, calls } = fakeFetch(() => rows([{ a: 1 }]));
    expect(await queryAnalyticsEngine({ ...base, fetch })).toEqual([{ a: 1 }]);
    expect(calls[0]).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql',
      sql: 'SELECT 1',
    });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('explains authorisation failures without echoing the token', async () => {
    const { fetch } = fakeFetch(() => new Response('{"errors":[{"message":"nope"}]}', { status: 403 }));
    const err = await queryAnalyticsEngine({ ...base, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(AnalyticsEngineQueryError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('Account Analytics: Read');
    expect(err.message).not.toContain('secret-token');
  });

  it('reports network failures, non-JSON answers and bad account ids', async () => {
    const down = fakeFetch(() => {
      throw new Error('connect refused');
    });
    await expect(queryAnalyticsEngine({ ...base, fetch: down.fetch })).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining('connect refused'),
    });
    const html = fakeFetch(() => new Response('<html>', { status: 200 }));
    await expect(queryAnalyticsEngine({ ...base, fetch: html.fetch })).rejects.toThrow(/not JSON/);
    await expect(queryAnalyticsEngine({ ...base, accountId: '../x' })).rejects.toThrow(/account id/);
    const empty = fakeFetch(() => new Response('{}'));
    expect(await queryAnalyticsEngine({ ...base, fetch: empty.fetch })).toEqual([]);
  });

  it('gives up after the timeout', async () => {
    const slow = fakeFetch(
      (_sql, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(queryAnalyticsEngine({ ...base, fetch: slow.fetch, timeoutMs: 20 })).rejects.toThrow(
      /did not answer in time/,
    );
  });
});

describe('analyticsEngineVitalsSource()', () => {
  const answer = (sql: string) => {
    if (sql.includes('toStartOfInterval'))
      return rows([
        { bucket: '2026-10-31 00:00:00', metric: 'LCP', p75: 2000, samples: 40 },
        { bucket: '2026-10-31 06:00:00', metric: 'LCP', p75: 2200, samples: 60 },
      ]);
    if (sql.includes('blob2 AS rating'))
      return rows([
        { metric: 'LCP', rating: 'good', samples: 80 },
        { metric: 'LCP', rating: 'poor', samples: 20 },
      ]);
    if (sql.includes('index1 AS route'))
      return rows([{ route: '/', metric: 'LCP', p75: 2100, p50: 1500, samples: 100 }]);
    return rows([{ metric: 'LCP', p75: 2100, p50: 1500, samples: 100 }]);
  };

  it('runs four queries and assembles one snapshot', async () => {
    const { fetch, calls } = fakeFetch(answer);
    const source = analyticsEngineVitalsSource({
      accountId: 'acc123',
      apiToken: 't',
      dataset: 'shop_vitals',
      fetch,
    });
    const snapshot = await source.query({ days: 7, route: '/blog', now: NOW });
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.sql.includes("index1 = '/blog'"))).toBe(true);
    expect(snapshot.source).toEqual({
      kind: 'analytics-engine',
      label: 'Analytics Engine · shop_vitals',
      partial: false,
    });
    expect(snapshot).toMatchObject({ days: 7, route: '/blog', bucketSeconds: 21_600, generatedAt: NOW });
    expect(snapshot.overall[0]).toMatchObject({ name: 'LCP', p75: 2100, rating: 'good' });
    expect(snapshot.overall[0]!.distribution).toEqual({ good: 80, 'needs-improvement': 0, poor: 20 });
    expect(snapshot.trend).toHaveLength(2);
    expect(snapshot.routes[0]!.route).toBe('/');
  });

  it('fails when any query fails, and rejects a bad dataset up front', async () => {
    const { fetch } = fakeFetch((sql) =>
      sql.includes('toStartOfInterval') ? new Response('boom', { status: 500 }) : answer(sql),
    );
    const source = analyticsEngineVitalsSource({ accountId: 'acc123', apiToken: 't', dataset: 'ds', fetch });
    await expect(source.query({ days: 1 })).rejects.toThrow(/returned 500/);
    expect(() =>
      analyticsEngineVitalsSource({ accountId: 'acc123', apiToken: 't', dataset: 'a b' }),
    ).toThrow();
  });
});

describe('cachedVitalsSource()', () => {
  const snapshot = (n: number): VitalsSnapshot => ({
    source: { kind: 'custom', label: 'x', partial: false },
    days: 1,
    route: null,
    generatedAt: n,
    bucketSeconds: 3600,
    overall: [],
    routes: [],
    trend: [],
  });

  it('reuses a snapshot within the ttl and refreshes it afterwards', async () => {
    let n = 0;
    const query = vi.fn(async () => snapshot(++n));
    const source = cachedVitalsSource({ query } satisfies VitalsSource, { ttlSeconds: 60 });
    expect((await source.query({ days: 1, now: 1000 })).generatedAt).toBe(1);
    expect((await source.query({ days: 1, now: 30_000 })).generatedAt).toBe(1);
    expect((await source.query({ days: 1, now: 61_001 })).generatedAt).toBe(2);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keys by window and route, and bounds the cache', async () => {
    const query = vi.fn(async () => snapshot(0));
    const source = cachedVitalsSource({ query }, { ttlSeconds: 60, maxEntries: 2 });
    await source.query({ days: 1, now: 0 });
    await source.query({ days: 7, now: 0 });
    await source.query({ days: 1, route: '/a', now: 0 });
    expect(query).toHaveBeenCalledTimes(3);
    await source.query({ days: 1, now: 0 }); // evicted by the bound
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('shares one in-flight query and forgets failures', async () => {
    let release!: (s: VitalsSnapshot) => void;
    const query = vi
      .fn<VitalsSource['query']>()
      .mockImplementationOnce(() => new Promise<VitalsSnapshot>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(snapshot(9));
    const source = cachedVitalsSource({ query });
    const a = source.query({ days: 1, now: 0 });
    const b = source.query({ days: 1, now: 0 });
    release(snapshot(5));
    expect((await a).generatedAt).toBe(5);
    expect((await b).generatedAt).toBe(5);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(source.query({ days: 2, now: 0 })).rejects.toThrow('down');
    expect((await source.query({ days: 2, now: 0 })).generatedAt).toBe(9);
  });
});

describe('memoryVitals()', () => {
  it('aggregates what it received into a partial snapshot', async () => {
    const clock = { now: NOW };
    const mem = memoryVitals({ now: () => clock.now });
    for (const v of [1000, 2000, 3000, 4000])
      mem.sink.write(
        payload('LCP', v, { route: 'app:/', rating: v <= 2500 ? 'good' : 'needs-improvement' }),
        {},
      );
    mem.sink.write(payload('CLS', 0.3, { route: 'app:/blog', pathname: '/blog/x', rating: 'poor' }), {});
    const snapshot = await mem.source.query({ days: 1 });
    expect(snapshot.source).toMatchObject({ kind: 'memory', partial: true });
    expect(snapshot.overall.map((o) => o.name)).toEqual(['LCP', 'CLS']);
    expect(snapshot.overall[0]).toMatchObject({ p75: 3000, p50: 2000, samples: 4 });
    expect(snapshot.overall[0]!.distribution).toEqual({ good: 2, 'needs-improvement': 2, poor: 0 });
    expect(snapshot.overall[1]).toMatchObject({ rating: 'poor' });
    expect(snapshot.routes.map((r) => r.route)).toEqual(['app:/', 'app:/blog']);
    expect(snapshot.trend.length).toBeGreaterThan(0);
    const filtered = await mem.source.query({ days: 1, route: '/blog/x' });
    expect(filtered.overall.map((o) => o.name)).toEqual(['CLS']);
    expect(filtered.route).toBe('/blog/x');
  });

  it('drops the oldest measurements, forgets old ones and weighs by the sample rate', async () => {
    const clock = { now: NOW };
    const mem = memoryVitals({ capacity: 10, sampleRate: 0.25, now: () => clock.now });
    for (let i = 0; i < 25; i++) mem.sink.write(payload('LCP', i, { route: `/r${i}` }), {});
    expect(mem.size()).toBe(10);
    const kept = await mem.source.query({ days: 1 });
    expect(kept.routes.map((r) => r.route).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `/r${15 + i}`).sort(),
    );
    // 10 kept measurements at a 25 % sample rate stand for 40 page views.
    expect(kept.overall[0]!.samples).toBe(40);
    clock.now = NOW + 2 * DAY;
    expect((await mem.source.query({ days: 1 })).overall).toEqual([]);
    expect((await mem.source.query({ days: 7 })).overall).toHaveLength(1);
    mem.clear();
    expect(mem.size()).toBe(0);
    expect((await mem.source.query({ days: 7 })).overall).toEqual([]);
  });
});

describe('renderVitalsDashboard()', () => {
  const snapshot = async (): Promise<VitalsSnapshot> => {
    const mem = memoryVitals({ now: () => NOW });
    for (let i = 0; i < 6; i++) {
      mem.sink.write(payload('LCP', 1500 + i * 300, { route: '<b>route</b>', rating: 'good' }), {});
      mem.sink.write(payload('CLS', 0.05 * i, { route: 'app:/x', rating: 'good' }), {});
    }
    return mem.source.query({ days: 7, now: NOW });
  };
  const options = { nonce: 'abc123==', siteName: 'Shop <script>alert(1)</script>', path: '/_hypdriv/dash' };

  it('renders cards, a route table and the source without any script', async () => {
    const html = renderVitalsDashboard({ snapshot: await snapshot(), days: 7 }, options);
    expect(html).toContain('<style nonce="abc123==">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('Largest Contentful Paint');
    expect(html).toContain('Cumulative Layout Shift');
    expect(html).toContain('Partial data.');
    expect(html).toContain('<table>');
    expect(html).toContain('format=json');
    expect(html).toContain('<svg class="dist"');
    expect(html).toContain('role="img"');
  });

  it('escapes every dynamic string', async () => {
    const html = renderVitalsDashboard(
      {
        snapshot: await snapshot(),
        days: 7,
        route: '"><img src=x onerror=alert(1)>',
        error: '<u>failed</u>',
        notes: ['Set `A<B>` now <i>please</i>'],
      },
      { ...options, nonce: 'n"><x' },
    );
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>route</b>');
    expect(html).not.toContain('<u>failed</u>');
    expect(html).not.toContain('<i>please</i>');
    expect(html).toContain('&lt;b&gt;route&lt;/b&gt;');
    expect(html).toContain('<code>A&lt;B&gt;</code>');
    expect(html).toContain('nonce="n&quot;&gt;&lt;x"');
    expect(html).toContain('Shop &lt;script&gt;');
  });

  it('shows the empty, error and not-configured states', () => {
    const empty = renderVitalsDashboard(
      {
        snapshot: {
          source: { kind: 'analytics-engine', label: 'ds', partial: false },
          days: 7,
          route: null,
          generatedAt: NOW,
          bucketSeconds: 21_600,
          overall: [],
          routes: [],
          trend: [],
        },
        days: 7,
      },
      options,
    );
    expect(empty).toContain('No Web Vitals were recorded in the last 7 days');
    expect(empty).not.toContain('Partial data');
    const failed = renderVitalsDashboard(
      { snapshot: null, days: 1, error: 'Analytics Engine returned 500' },
      options,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Analytics Engine returned 500');
    expect(failed).toContain('last 1 day<');
    const unconfigured = renderVitalsDashboard(
      { snapshot: null, days: 7, notes: ['No vitals source is configured.'] },
      options,
    );
    expect(unconfigured).toContain('No vitals source is configured.');
    expect(unconfigured).not.toContain('Source:');
  });

  it('offers the chosen window even when it is not a preset', () => {
    const html = renderVitalsDashboard({ snapshot: null, days: 45 }, options);
    expect(html).toContain('<option value="45" selected>45 days</option>');
  });
});

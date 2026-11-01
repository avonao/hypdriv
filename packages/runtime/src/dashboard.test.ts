import { emptyManifest } from '@hypdriv/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from './handler';

const TOKEN = 'dash-access-token-0123456789abcdef';
const manifest = emptyManifest({ buildId: 'b1' });
const upstream = async () => new Response('app', { headers: { 'content-type': 'text/html' } });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function make(dashboard: unknown = true, extra: Record<string, unknown> = {}) {
  return createHandler({
    config: { observe: { vitals: { dashboard, ...extra } } } as never,
    manifest,
    target: 'node',
  });
}

type Handler = ReturnType<typeof make>;
const get = (handler: Handler, path: string, init: RequestInit = {}, origin = 'https://example.com') =>
  handler(new Request(`${origin}${path}`, init), { upstream });

/** Signs in with `?token=` and returns the cookie the redirect sets, as a `Cookie` header value. */
async function signIn(handler: Handler, origin = 'https://example.com'): Promise<string> {
  const res = await get(handler, `/_hypdriv/dash?token=${TOKEN}`, {}, origin);
  expect(res.status).toBe(303);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function beacon(handler: Handler, name: string, value: number, route = 'page:/') {
  const res = await handler(
    new Request('https://example.com/_hypdriv/vitals', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify({ name, value, id: `${name}-${value}`, pathname: '/', route }),
    }),
    { upstream },
  );
  expect(res.status).toBeLessThan(300);
}

describe('GET /_hypdriv/dash', () => {
  it('does not exist unless observe.vitals.dashboard is on', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = createHandler({ config: {}, manifest, target: 'node' });
    expect((await get(handler, `/_hypdriv/dash?token=${TOKEN}`)).status).toBe(404);
    const off = make(false);
    expect((await get(off, `/_hypdriv/dash?token=${TOKEN}`)).status).toBe(404);
  });

  it('does not exist without a sufficiently long access token', async () => {
    const handler = make();
    expect((await get(handler, '/_hypdriv/dash?token=anything-at-all-goes-here')).status).toBe(404);
    vi.stubEnv('HYPDRIV_DASH_TOKEN', 'too-short');
    const short = make();
    expect((await get(short, '/_hypdriv/dash?token=too-short')).status).toBe(404);
    expect(
      (await get(short, '/_hypdriv/dash', { headers: { authorization: 'Bearer too-short' } })).status,
    ).toBe(404);
  });

  it('answers 404 to visitors, wrong tokens, wrong bearers and foreign cookies', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make();
    for (const [path, init] of [
      ['/_hypdriv/dash', {}],
      ['/_hypdriv/dash?token=wrong', {}],
      [`/_hypdriv/dash?token=${TOKEN}x`, {}],
      ['/_hypdriv/dash', { headers: { authorization: 'Bearer wrong' } }],
      ['/_hypdriv/dash', { headers: { authorization: `Basic ${TOKEN}` } }],
      ['/_hypdriv/dash', { headers: { cookie: '__Secure-hypdriv-dash=v1.9999999999.abc' } }],
      ['/_hypdriv/dash', { method: 'POST', body: '{}' }],
    ] as Array<[string, RequestInit]>) {
      const res = await get(handler, path, init);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.text()).not.toContain('Web Vitals');
    }
  });

  it('exchanges ?token= for a session cookie and strips the token from the address', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make();
    const res = await get(handler, `/_hypdriv/dash?days=14&token=${TOKEN}&route=%2Fblog`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/_hypdriv/dash?days=14&route=%2Fblog');
    expect(res.headers.get('location')).not.toContain(TOKEN);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Secure-hypdriv-dash=v1\./);
    expect(cookie).toContain('Path=/_hypdriv/dash');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie).not.toContain(TOKEN);
  });

  it('uses a plain, non-Secure cookie over http (local development)', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make({ sessionMinutes: 30 });
    const res = await get(handler, `/_hypdriv/dash?token=${TOKEN}`, {}, 'http://localhost:3000');
    expect(res.status).toBe(303);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^hypdriv-dash=v1\./);
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('Max-Age=1800');
  });

  it('serves the page to a signed-in browser with its own strict CSP and no caching', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make();
    const cookie = await signIn(handler);
    const res = await get(handler, '/_hypdriv/dash', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    const nonce = /<style nonce="([^"]+)">/.exec(body)?.[1];
    expect(nonce).toBeTruthy();
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(body).not.toMatch(/<script/i);
    // Nothing recorded yet: the memory fallback says so and names what durable storage needs.
    expect(body).toContain('No Web Vitals were recorded');
    expect(body).toContain('HYPDRIV_ANALYTICS_ACCOUNT_ID');
    const second = await get(handler, '/_hypdriv/dash', { headers: { cookie } });
    const nonce2 = /<style nonce="([^"]+)">/.exec(await second.text())?.[1];
    expect(nonce2).not.toBe(nonce);
  });

  it('answers HEAD without a body and refuses other methods once signed in', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make();
    const cookie = await signIn(handler);
    const head = await get(handler, '/_hypdriv/dash', { method: 'HEAD', headers: { cookie } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await get(handler, '/_hypdriv/dash', { method: 'POST', headers: { cookie }, body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('binds the session cookie to the host it was issued for', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make();
    const cookie = await signIn(handler);
    const other = await get(handler, '/_hypdriv/dash', { headers: { cookie } }, 'https://other.example.net');
    expect(other.status).toBe(404);
  });

  it('shows what visitors reported, without any infrastructure, as partial data', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make();
    for (const v of [1200, 1800, 2600, 3900]) await beacon(handler, 'LCP', v);
    await beacon(handler, 'INP', 120, 'page:/account');
    const cookie = await signIn(handler);
    const res = await get(handler, '/_hypdriv/dash', { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('Largest Contentful Paint');
    expect(body).toContain('Interaction to Next Paint');
    expect(body).toContain('Partial data.');
    expect(body).toContain('page:/account');
    expect(body).toContain('4 measurements');
  });

  it('answers JSON to a bearer token or ?format=json, and honours days and route', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make({ days: 14 });
    await beacon(handler, 'LCP', 2000, 'page:/a');
    await beacon(handler, 'LCP', 3000, 'page:/b');
    const res = await get(handler, '/_hypdriv/dash?format=json', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('set-cookie')).toBeNull();
    const data = (await res.json()) as {
      ok: boolean;
      snapshot: { days: number; overall: Array<{ samples: number }>; routes: unknown[] };
    };
    expect(data.ok).toBe(true);
    expect(data.snapshot.days).toBe(14);
    expect(data.snapshot.overall[0]!.samples).toBe(2);
    expect(data.snapshot.routes).toHaveLength(2);
    const filtered = await get(handler, '/_hypdriv/dash?days=3&route=page%3A%2Fa', {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    });
    const one = (await filtered.json()) as {
      snapshot: { days: number; route: string; overall: Array<{ samples: number }> };
    };
    expect(one.snapshot).toMatchObject({ days: 3, route: 'page:/a' });
    expect(one.snapshot.overall[0]!.samples).toBe(1);
    const bad = await get(handler, '/_hypdriv/dash?format=json&days=9999', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await bad.json()) as { snapshot: { days: number } }).snapshot.days).toBe(14);
  });

  it('keeps the memory fallback off when memoryCapacity is 0', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const handler = make({ memoryCapacity: 0 });
    await beacon(handler, 'LCP', 2000);
    const res = await get(handler, '/_hypdriv/dash?format=json', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { ok: boolean; snapshot: unknown; notes: string[] };
    expect(data).toMatchObject({ ok: false, snapshot: null });
    expect(data.notes.join(' ')).toContain('HYPDRIV_ANALYTICS_API_TOKEN');
  });
});

describe('GET /_hypdriv/dash with a custom source', () => {
  it('renders whatever a platform-provided VitalsSource returns, and shows its failures', async () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        source: { kind: 'custom', label: 'Warehouse', partial: false },
        days: 7,
        route: null,
        generatedAt: Date.parse('2026-10-31T12:00:00Z'),
        bucketSeconds: 21_600,
        overall: [
          {
            name: 'LCP',
            p75: 1900,
            p50: 1400,
            samples: 12,
            rating: 'good',
            distribution: { good: 12, 'needs-improvement': 0, poor: 0 },
          },
        ],
        routes: [],
        trend: [],
      })
      .mockRejectedValueOnce(new Error('warehouse offline'));
    const handler = createHandler({
      config: { observe: { vitals: { dashboard: true } } },
      manifest,
      target: 'node',
      platform: { vitalsSource: { query } },
    });
    const cookie = await signIn(handler);
    const ok = await get(handler, '/_hypdriv/dash?days=7&route=%2Fx', { headers: { cookie } });
    expect(await ok.text()).toContain('Warehouse');
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ days: 7, route: '/x' }));
    const failed = await get(handler, '/_hypdriv/dash', { headers: { cookie } });
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('warehouse offline');
  });
});

describe('GET /_hypdriv/dash with Analytics Engine', () => {
  const stubAnalytics = (respond: (sql: string) => Response) => {
    const calls: Array<{ url: string; sql: string; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const sql = String(init?.body ?? '');
        calls.push({
          url: String(input),
          sql,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return respond(sql);
      }),
    );
    return calls;
  };
  const data = (rows: unknown[]) => new Response(JSON.stringify({ data: rows }));
  const answer = (sql: string) => {
    if (sql.includes('toStartOfInterval'))
      return data([
        { bucket: '2026-10-30 00:00:00', metric: 'LCP', p75: 2600, samples: 80 },
        { bucket: '2026-10-31 00:00:00', metric: 'LCP', p75: 2300, samples: 90 },
      ]);
    if (sql.includes('blob2 AS rating'))
      return data([
        { metric: 'LCP', rating: 'good', samples: 120 },
        { metric: 'LCP', rating: 'needs-improvement', samples: 50 },
      ]);
    if (sql.includes('index1 AS route'))
      return data([{ route: 'page:/', metric: 'LCP', p75: 2300, p50: 1700, samples: 170 }]);
    return data([{ metric: 'LCP', p75: 2300, p50: 1700, samples: 170 }]);
  };
  const env = () => {
    vi.stubEnv('HYPDRIV_DASH_TOKEN', TOKEN);
    vi.stubEnv('HYPDRIV_ANALYTICS_ACCOUNT_ID', 'acc123');
    vi.stubEnv('HYPDRIV_ANALYTICS_API_TOKEN', 'cf-read-token');
    vi.stubEnv('HYPDRIV_ANALYTICS_DATASET', 'shop_vitals');
  };

  it('renders p75 from the SQL API, once per minute, without the in-memory caveat', async () => {
    env();
    const calls = stubAnalytics(answer);
    const handler = make(true, { sink: 'analytics-engine' });
    const cookie = await signIn(handler);
    const res = await get(handler, '/_hypdriv/dash?days=7', { headers: { cookie } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('Analytics Engine · shop_vitals');
    expect(body).toContain('2.30 s');
    expect(body).toContain('170 measurements');
    expect(body).not.toContain('Partial data');
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql');
    expect(calls[0]!.authorization).toBe('Bearer cf-read-token');
    expect(calls.every((c) => c.sql.includes("INTERVAL '7' DAY"))).toBe(true);
    // The token and account never reach the page.
    expect(body).not.toContain('cf-read-token');
    await get(handler, '/_hypdriv/dash?days=7', { headers: { cookie } });
    expect(calls).toHaveLength(4);
    await get(handler, '/_hypdriv/dash?days=3', { headers: { cookie } });
    expect(calls).toHaveLength(8);
  });

  it('points out a sink that does not feed the dataset', async () => {
    env();
    stubAnalytics(answer);
    const handler = make();
    const cookie = await signIn(handler);
    const body = await (await get(handler, '/_hypdriv/dash', { headers: { cookie } })).text();
    expect(body).toContain('observe.vitals.sink');
    expect(body).toContain('analytics-engine');
  });

  it('reports a failing query as 502 without leaking credentials, and recovers', async () => {
    env();
    let healthy = false;
    const calls = stubAnalytics((sql) =>
      healthy ? answer(sql) : new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }),
    );
    const handler = make(true, { sink: 'analytics-engine' });
    const cookie = await signIn(handler);
    const failed = await get(handler, '/_hypdriv/dash', { headers: { cookie } });
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(body).toContain('Could not read Web Vitals');
    expect(body).toContain('Account Analytics: Read');
    expect(body).not.toContain('cf-read-token');
    healthy = true;
    const recovered = await get(handler, '/_hypdriv/dash', { headers: { cookie } });
    expect(recovered.status).toBe(200);
    expect(calls.length).toBeGreaterThan(4);
  });

  it('falls back to memory when the dataset name cannot be used in SQL', async () => {
    env();
    vi.stubEnv('HYPDRIV_ANALYTICS_DATASET', 'bad name;');
    const calls = stubAnalytics(answer);
    const handler = make();
    await beacon(handler, 'LCP', 1500);
    const cookie = await signIn(handler);
    const body = await (await get(handler, '/_hypdriv/dash', { headers: { cookie } })).text();
    expect(calls).toHaveLength(0);
    expect(body).toContain('Partial data.');
    expect(body).toContain('1 measurement<');
  });
});

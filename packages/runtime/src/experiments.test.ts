import { emptyManifest, parseCookies, parseExperimentCookie } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { createHandler } from './handler';

const manifest = emptyManifest({ buildId: 'b1' });
const page = () =>
  new Response('<!doctype html><html><head></head><body>x</body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

function recordingBinding() {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return { points, binding: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) } };
}

function app(flags: Record<string, unknown> = {}) {
  return createHandler({
    config: {
      flags: {
        definitions: {
          checkout: { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
        },
        ...flags,
      },
      observe: { vitals: { sink: 'analytics-engine' } },
    } as never,
    manifest,
    target: 'node',
  });
}

/** `name=value` pairs of every Set-Cookie header. */
const cookiesOf = (res: Response) =>
  Object.fromEntries(
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );
const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

describe('edge experiments through the handler', () => {
  it('counts a visitor once per experiment in Analytics Engine and keeps the variant sticky', async () => {
    const { points, binding } = recordingBinding();
    const handler = app();
    const env = { HYPDRIV_ANALYTICS: binding };
    const first = await handler(new Request('https://example.com/pricing'), { upstream: page, env });
    expect(first.status).toBe(200);
    const cookies = cookiesOf(first);
    const memberships = parseExperimentCookie(decodeURIComponent(cookies.hyp_exp ?? ''));
    expect(memberships.checkout?.exposed).toBe(true);
    expect(['control', 'b']).toContain(memberships.checkout?.variant);
    const exposures = points.filter((p) => p.blobs?.[0] === 'experiment.exposure');
    expect(exposures).toHaveLength(1);
    // The exposure names the route pattern; with no route in the manifest, `(unmatched)` — never the visited URL.
    expect(exposures[0]?.blobs?.slice(1, 4)).toEqual([
      'checkout',
      memberships.checkout?.variant,
      '(unmatched)',
    ]);
    expect(exposures[0]?.indexes).toEqual(['checkout']);

    // The same visitor again: same variant, no second exposure.
    const again = await handler(
      new Request('https://example.com/pricing', { headers: { cookie: cookieHeader(cookies) } }),
      { upstream: page, env },
    );
    expect(again.status).toBe(200);
    expect(points.filter((p) => p.blobs?.[0] === 'experiment.exposure')).toHaveLength(1);
  });

  it('does not count API responses, prefetches or non-HTML', async () => {
    const { points, binding } = recordingBinding();
    const handler = app();
    const env = { HYPDRIV_ANALYTICS: binding };
    await handler(new Request('https://example.com/api/x'), {
      upstream: () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      env,
    });
    await handler(new Request('https://example.com/pricing', { headers: { 'sec-purpose': 'prefetch' } }), {
      upstream: page,
      env,
    });
    expect(points.filter((p) => p.blobs?.[0] === 'experiment.exposure')).toHaveLength(0);
  });

  it('tags the visitor’s vitals beacon with the variants from the experiment cookie', async () => {
    const { points, binding } = recordingBinding();
    const handler = app();
    const env = { HYPDRIV_ANALYTICS: binding };
    const first = await handler(new Request('https://example.com/'), { upstream: page, env });
    const cookies = cookiesOf(first);
    const variant = parseExperimentCookie(decodeURIComponent(cookies.hyp_exp ?? '')).checkout?.variant;
    const res = await handler(
      new Request('https://example.com/_hypdriv/vitals', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'cf-connecting-ip': '203.0.113.9',
          cookie: cookieHeader(cookies),
        },
        body: JSON.stringify({ name: 'LCP', value: 1800, id: 'v1', pathname: '/', route: 'page:/' }),
      }),
      { upstream: page, env },
    );
    expect(res.status).toBeLessThan(300);
    const vital = points.find((p) => p.blobs?.[0] === 'LCP');
    expect(vital?.blobs?.[7]).toBe(`|checkout:${variant}|`);
  });

  it('counts the visit of a prerendered page when its beacon reports the activation', async () => {
    const { points, binding } = recordingBinding();
    const handler = createHandler({
      config: {
        flags: {
          definitions: {
            checkout: {
              default: 'control',
              experiment: { variants: { control: 1, b: 1 }, expose: ['/orders/*'] },
            },
          },
        },
        observe: { vitals: { sink: 'analytics-engine' } },
      } as never,
      manifest: emptyManifest({
        buildId: 'b1',
        routes: [
          { id: 'app:/orders/[id]', kind: 'app-page', pathname: '/orders/[id]', dynamic: true } as never,
        ],
      }),
      target: 'node',
    });
    const env = { HYPDRIV_ANALYTICS: binding };
    const exposures = () => points.filter((p) => p.blobs?.[0] === 'experiment.exposure');
    // The browser prerenders the page: assigned, remembered, but not counted (the visitor may never open it).
    const prerender = await handler(
      new Request('https://example.com/orders/8f2a-secret-token', {
        headers: { 'sec-purpose': 'prefetch;prerender' },
      }),
      { upstream: page, env },
    );
    const cookies = cookiesOf(prerender);
    expect(parseExperimentCookie(decodeURIComponent(cookies.hyp_exp ?? '')).checkout?.exposed).toBe(false);
    expect(exposures()).toHaveLength(0);
    // The visitor opens it: no request, only the page's beacon says so.
    const beacon = await handler(
      new Request('https://example.com/_hypdriv/vitals', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'cf-connecting-ip': '203.0.113.20',
          cookie: cookieHeader(cookies),
        },
        body: JSON.stringify({
          name: 'TTFB',
          value: 0,
          id: 'v9',
          pathname: '/orders/8f2a-secret-token',
          navigationType: 'prerender',
        }),
      }),
      { upstream: page, env },
    );
    expect(beacon.status).toBe(204);
    expect(exposures()).toHaveLength(1);
    // The row names the route pattern, never the visited URL.
    expect(exposures()[0]?.blobs?.slice(1, 5)).toEqual([
      'checkout',
      parseExperimentCookie(decodeURIComponent(cookies.hyp_exp ?? '')).checkout?.variant,
      '/orders/[id]',
      'app:/orders/[id]',
    ]);
    // (The vitals row of the same beacon keeps the pathname the page reported: hot-page warming learns from it.)
    expect(JSON.stringify(exposures())).not.toContain('secret-token');
    // The cookie now carries the mark, so the next real request does not count the visitor again.
    const marked = cookiesOf(beacon);
    expect(parseExperimentCookie(decodeURIComponent(marked.hyp_exp ?? '')).checkout?.exposed).toBe(true);
    await handler(
      new Request('https://example.com/orders/8f2a-secret-token', {
        headers: { cookie: cookieHeader(marked) },
      }),
      { upstream: page, env },
    );
    expect(exposures()).toHaveLength(1);
    // The same beacon again (a replay) is not a second exposure.
    await handler(
      new Request('https://example.com/_hypdriv/vitals', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'cf-connecting-ip': '203.0.113.20',
          cookie: cookieHeader(marked),
        },
        body: JSON.stringify({
          name: 'TTFB',
          value: 0,
          id: 'v10',
          pathname: '/orders/1',
          navigationType: 'prerender',
        }),
      }),
      { upstream: page, env },
    );
    expect(exposures()).toHaveLength(1);
  });

  it('ignores a forged tag in the beacon body and clears it without a cookie', async () => {
    const { points, binding } = recordingBinding();
    const handler = app();
    const env = { HYPDRIV_ANALYTICS: binding };
    await handler(
      new Request('https://example.com/_hypdriv/vitals', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'cf-connecting-ip': '203.0.113.10' },
        body: JSON.stringify({
          name: 'LCP',
          value: 900,
          id: 'v2',
          pathname: '/',
          experiments: '|checkout:b|',
        }),
      }),
      { upstream: page, env },
    );
    expect(points.find((p) => p.blobs?.[0] === 'LCP')?.blobs?.[7]).toBe('');
  });

  it('writes nothing with exposures "none" and logs without a binding', async () => {
    const { points, binding } = recordingBinding();
    const off = app({ exposures: 'none' });
    const res = await off(new Request('https://example.com/'), {
      upstream: page,
      env: { HYPDRIV_ANALYTICS: binding },
    });
    expect(res.status).toBe(200);
    expect(points.filter((p) => p.blobs?.[0] === 'experiment.exposure')).toHaveLength(0);
    // Without a binding the exposure goes to the log and the request still succeeds with a sticky cookie.
    const bare = await app()(new Request('https://example.com/'), { upstream: page, env: {} });
    expect(bare.status).toBe(200);
    expect(parseCookies(cookieHeader(cookiesOf(bare))).hyp_exp).toBeTruthy();
  });
});

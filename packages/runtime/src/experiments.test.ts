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
    expect(exposures[0]?.blobs?.slice(1, 4)).toEqual(['checkout', memberships.checkout?.variant, '/pricing']);
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

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createContext,
  HEADER,
  type HypContext,
  loadConfig,
  runWithContext,
  setContextStore,
} from '@hypdriv/core';
import { decodeFlagsHeader } from '@hypdriv/flags';
import { encodeGeoHeader, type GeoInfo } from '@hypdriv/runtime';
import { signing } from '@hypdriv/security';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defer, devtoolsMeta, flag, geo, hyp, jobHandler, nonce, setCloudflareContextLoader } from './index';

const als = new AsyncLocalStorage<HypContext>();

const geoOf = (partial: Partial<GeoInfo>): GeoInfo => ({
  country: null,
  region: null,
  regionCode: null,
  city: null,
  continent: null,
  postalCode: null,
  timezone: null,
  latitude: null,
  longitude: null,
  colo: null,
  asn: null,
  asOrganization: null,
  isEU: false,
  source: 'cloudflare',
  ...partial,
});

const env = process.env as Record<string, string | undefined>;

beforeAll(() => {
  setContextStore({ getStore: () => als.getStore(), run: (ctx, fn) => als.run(ctx, fn) });
});

afterAll(() => {
  setContextStore(null);
  setCloudflareContextLoader(null);
});

function pipelineContext(
  headers: Record<string, string>,
  env: Record<string, unknown> = {},
  config = loadConfig({}),
): { ctx: HypContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = createContext({
    request: new Request('https://shop.example.com/products/1', { headers }),
    config,
    env,
    runner: 'worker',
    waitUntil: (p) => pending.push(p),
  });
  for (const [k, v] of Object.entries(headers)) ctx.requestHeaders.set(k, v);
  return { ctx, pending };
}

describe('hyp()', () => {
  it('reads forwarded HypDriv headers inside the Worker pipeline', async () => {
    const { ctx, pending } = pipelineContext(
      {
        [HEADER.hypRequestId]: 'req-1',
        [HEADER.nonce]: 'abc123',
        [HEADER.geo]: encodeGeoHeader(geoOf({ country: 'US', region: 'CA', city: 'San Francisco' })),
        [HEADER.locale]: 'en-US',
        [HEADER.flags]: JSON.stringify({ newCheckout: true, plan: 'pro' }),
        [HEADER.theme]: 'contrast=high;mode=dark',
        [HEADER.runner]: 'worker',
        cookie: 'a=1; b=two',
      },
      { HYPDRIV_KV: {} },
    );
    const result = await runWithContext(ctx, () => hyp());
    expect(result.requestId).toBe('req-1');
    expect(result.nonce).toBe('abc123');
    expect(result.country).toBe('US');
    expect(result.geo?.city).toBe('San Francisco');
    expect(result.locale).toBe('en-US');
    expect(result.flags).toEqual({ newCheckout: true, plan: 'pro' });
    expect(result.flag('newCheckout', false)).toBe(true);
    expect(result.flag('missing', 'fallback')).toBe('fallback');
    expect(result.theme).toEqual({ contrast: 'high', mode: 'dark' });
    expect(result.runner).toBe('worker');
    expect(result.cookies).toEqual({ a: '1', b: 'two' });
    expect(result.env).toHaveProperty('HYPDRIV_KV');
    expect(result.pipeline).toBe(ctx);
    result.waitUntil(Promise.resolve('done'));
    expect(pending).toHaveLength(1);
  });

  it('resolves the theme from cookies when the theme stage did not run (RSC navigations)', async () => {
    const config = loadConfig({
      purser: { theme: { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light' } } } },
    });
    const { ctx } = pipelineContext({ cookie: 'hyp_theme=dark' }, {}, config);
    const result = await runWithContext(ctx, () => hyp());
    expect(result.theme).toEqual({ mode: 'dark' });
  });

  it('uses the OpenNext Cloudflare context outside the pipeline', async () => {
    const waitUntil = vi.fn();
    setCloudflareContextLoader(async () => ({
      env: { SECRET: 'x' },
      cf: { country: 'DE' },
      ctx: { waitUntil },
    }));
    // Outside a pipeline, request headers come from next/headers; provide them through a context with no store.
    setContextStore(null);
    vi.doMock('next/headers', () => ({ headers: async () => new Headers({ 'cf-ipcountry': 'DE' }) }));
    try {
      const result = await hyp();
      expect(result.env).toEqual({ SECRET: 'x' });
      expect(result.cf).toEqual({ country: 'DE' });
      expect(result.country).toBe('DE');
      expect(result.pipeline).toBeUndefined();
      result.waitUntil(Promise.resolve());
      expect(waitUntil).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('next/headers');
      setCloudflareContextLoader(null);
      setContextStore({ getStore: () => als.getStore(), run: (ctx, fn) => als.run(ctx, fn) });
    }
  });
});

describe('request helpers', () => {
  it('nonce(), geo(), flag() and devtoolsMeta() read the forwarded headers', async () => {
    const { ctx } = pipelineContext(
      {
        [HEADER.nonce]: 'n0nce',
        [HEADER.geo]: encodeGeoHeader(geoOf({ country: 'US', region: 'NY' })),
        [HEADER.flags]: JSON.stringify({ beta: 'on' }),
        [HEADER.hypRequestId]: 'req-9',
        [HEADER.runner]: 'proxy',
        [HEADER.route]: 'app:/products/[id]',
      },
      {},
      loadConfig({
        flags: {
          definitions: { beta: { default: 'off' }, internalPricing: { default: false, serverOnly: true } },
        },
      }),
    );
    ctx.requestHeaders.set(HEADER.flags, JSON.stringify({ beta: 'on', internalPricing: true }));
    await runWithContext(ctx, async () => {
      expect(await nonce()).toBe('n0nce');
      expect((await geo()).region).toBe('NY');
      expect(await flag('beta')).toBe('on');
      expect(await flag('other', 7)).toBe(7);
      const meta = await devtoolsMeta();
      expect(decodeFlagsHeader(meta['hypdriv:flags'])).toEqual({ beta: 'on' });
      expect(meta).toEqual({
        'hypdriv:request': 'req-9',
        'hypdriv:flags': meta['hypdriv:flags'],
        'hypdriv:runner': 'proxy',
        'hypdriv:route': 'app:/products/[id]',
      });
    });
  });

  it('defer() schedules work on the pipeline waitUntil', async () => {
    const { ctx, pending } = pipelineContext({});
    let ran = false;
    runWithContext(ctx, () =>
      defer(async () => {
        ran = true;
      }),
    );
    await Promise.all(pending);
    expect(ran).toBe(true);
  });
});

describe('jobHandler()', () => {
  const secret = 'internal-secret-with-enough-entropy-0123456789';

  async function call(
    request: Request,
    env: Record<string, unknown>,
    handler = vi.fn(async () => ({ processed: 2 })),
  ) {
    const { ctx } = pipelineContext({}, env);
    const route = jobHandler({}, handler);
    const response = await runWithContext(ctx, () => route(request));
    return { response, handler };
  }

  it('accepts signed internal requests and passes the job payload', async () => {
    const body = JSON.stringify({ job: 'digest', cron: '0 9 * * 1', payload: { week: 44 } });
    const request = await signing.signInternalRequest(
      new Request('https://app.example.com/api/jobs/digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      secret,
    );
    const { response, handler } = await call(request, { HYPDRIV_INTERNAL_SECRET: secret });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, job: 'digest', result: { processed: 2 } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'digest', cron: '0 9 * * 1', payload: { week: 44 } }),
    );
  });

  it('passes queue messages through', async () => {
    const messages = [
      { id: 'm1', timestamp: '2026-10-30T00:00:00.000Z', body: { to: 'a@example.com' }, attempts: 1 },
    ];
    const request = await signing.signInternalRequest(
      new Request('https://app.example.com/api/queues/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: 'emails', messages }),
      }),
      secret,
    );
    const { handler } = await call(request, { HYPDRIV_INTERNAL_SECRET: secret });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ job: 'emails', messages }));
  });

  it('rejects unsigned and tampered requests', async () => {
    const unsigned = new Request('https://app.example.com/api/jobs/digest', { method: 'POST' });
    expect((await call(unsigned, { HYPDRIV_INTERNAL_SECRET: secret })).response.status).toBe(401);

    const signed = await signing.signInternalRequest(
      new Request('https://app.example.com/api/jobs/digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"job":"a"}',
      }),
      secret,
    );
    const tampered = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: '{"job":"b"}',
    });
    const { response, handler } = await call(tampered, { HYPDRIV_INTERNAL_SECRET: secret });
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses to run without a secret outside development', async () => {
    const previous = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const { response } = await call(
        new Request('https://app.example.com/api/jobs/digest', { method: 'POST' }),
        {},
      );
      expect(response.status).toBe(503);
    } finally {
      env.NODE_ENV = previous;
    }
  });

  it('accepts Vercel Cron calls authenticated with CRON_SECRET', async () => {
    const request = new Request('https://app.example.com/api/jobs/digest', {
      method: 'GET',
      headers: {
        authorization: 'Bearer cron-secret-value-1234567890',
        'x-vercel-cron-schedule': '0 9 * * 1',
        'user-agent': 'vercel-cron/1.0',
      },
    });
    const { response, handler } = await call(request, { CRON_SECRET: 'cron-secret-value-1234567890' });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ job: 'digest', cron: '0 9 * * 1' }));
    const wrong = new Request('https://app.example.com/api/jobs/digest', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(
      (await call(wrong, { CRON_SECRET: 'cron-secret-value-1234567890', HYPDRIV_INTERNAL_SECRET: secret }))
        .response.status,
    ).toBe(401);
  });

  it('fills job and schedule of Vercel Cron calls from jobs.cron and honours the configured secret envs', async () => {
    const { getRuntime, registerRuntime } = await import('@hypdriv/core');
    const previous = getRuntime();
    registerRuntime({
      config: loadConfig({
        jobs: { cron: { nightly: { cron: '17 7 * * *', path: '/api/cron/run' } } },
        vercel: { cronSecretEnv: 'MY_CRON_SECRET' },
        security: { internalAuth: { secretEnv: 'MY_INTERNAL_SECRET' } },
      }),
      env: {},
      target: 'vercel',
    });
    // No HypDriv request context: a Vercel Function, where only the registered runtime exists and request
    // headers come from next/headers.
    setContextStore(null);
    vi.doMock('next/headers', () => ({ headers: async () => new Headers() }));
    try {
      const handler = vi.fn(async () => ({ done: true }));
      const route = jobHandler({}, handler);
      const cronCall = new Request('https://app.example.com/api/cron/run', {
        headers: { authorization: 'Bearer my-cron-secret-0123456789', 'user-agent': 'vercel-cron/1.0' },
      });
      const previousEnv = { cron: env.MY_CRON_SECRET, internal: env.MY_INTERNAL_SECRET };
      env.MY_CRON_SECRET = 'my-cron-secret-0123456789';
      env.MY_INTERNAL_SECRET = secret;
      try {
        const response = await route(cronCall);
        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ job: 'nightly', cron: '17 7 * * *' }));
        // CRON_SECRET is not the configured env: the default name is ignored.
        const legacy = new Request('https://app.example.com/api/cron/run', {
          headers: { authorization: 'Bearer my-cron-secret-0123456789x' },
        });
        expect((await route(legacy)).status).toBe(401);
        // Signed with the configured internal secret.
        const signed = await signing.signInternalRequest(
          new Request('https://app.example.com/api/cron/run', { method: 'POST' }),
          secret,
        );
        expect((await route(signed)).status).toBe(200);
      } finally {
        env.MY_CRON_SECRET = previousEnv.cron;
        env.MY_INTERNAL_SECRET = previousEnv.internal;
      }
    } finally {
      vi.doUnmock('next/headers');
      setContextStore({ getStore: () => als.getStore(), run: (ctx, fn) => als.run(ctx, fn) });
      registerRuntime(previous ?? null);
    }
  });

  it('reports handler failures as JSON errors', async () => {
    const request = await signing.signInternalRequest(
      new Request('https://app.example.com/api/jobs/x', { method: 'POST' }),
      secret,
    );
    const { response } = await call(
      request,
      { HYPDRIV_INTERNAL_SECRET: secret },
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, message: 'boom' });
  });
});

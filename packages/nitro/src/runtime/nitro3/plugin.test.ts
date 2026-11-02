import { createContext, getCurrentContext, loadConfig, runWithContext } from '@hypdriv/core';
import { createHandler, ensureContextStore, hyp } from '@hypdriv/runtime';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routeRules } from '../__fixtures__/nitro-app';
import { FACTS_KEY, type HypEventContext } from '../facts';
import { createNitro3Fetch, installNitro3Hook, type Nitro3Request, platformOf } from './hook';
import hypdrivNitro3Plugin from './plugin';

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PAGE = '<!DOCTYPE html><html><head></head><body><script>1</script></body></html>';

beforeAll(async () => {
  await ensureContextStore();
});

afterEach(() => {
  for (const key of Object.keys(routeRules)) delete routeRules[key];
});

interface Seen {
  facts: Record<string, HypEventContext | undefined>;
  requests: Nitro3Request[];
  requestIds: Array<string | undefined>;
}

/** A Nitro 3 app (`nitroApp.fetch`) with the Hypdriv plugin installed. */
function nitro() {
  const seen: Seen = { facts: {}, requests: [], requestIds: [] };
  const nitroApp = {
    fetch: async (request: Request): Promise<Response> => {
      const req = request as Nitro3Request;
      const { pathname } = new URL(request.url);
      seen.requests.push(req);
      seen.requestIds.push(hyp()?.requestId);
      seen.facts[pathname] = req.context?.[FACTS_KEY] as HypEventContext | undefined;
      if (pathname === '/api/boom') throw new Error('internal detail');
      if (pathname === '/api/echo')
        return new Response(await request.text(), { headers: { 'content-type': 'text/plain' } });
      if (pathname.startsWith('/assets/'))
        return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
    captureError: vi.fn(),
  };
  hypdrivNitro3Plugin(nitroApp);
  const get = (path: string, init: RequestInit = {}) =>
    nitroApp.fetch(
      new Request(`https://app.example.com${path}`, {
        ...init,
        headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US', ...init.headers },
      }),
    );
  return { get, seen, nitroApp };
}

describe('the Hypdriv Nitro 3 plugin', () => {
  it('wraps nitroApp.fetch with the build’s config, manifest and options', async () => {
    const { get, seen } = nitro();
    const response = await get('/page');
    expect(response.status).toBe(200);
    const facts = seen.facts['/page'];
    expect(response.headers.get('x-request-id')).toBe(facts?.requestId);
    expect(facts?.nonce).toBeTruthy();
    expect(facts?.runner).toBe('host');
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${facts?.nonce}'`);
    const html = await response.text();
    expect(html).toContain(`nonce="${facts?.nonce}"`);
    const health = (await (await get('/_hypdriv/health')).json()) as { service: string; framework: string };
    expect(health.service).toBe('nitro-plugin-test');
    expect(health.framework).toContain('Nitro 2.13.5');
  });

  it('runs the application inside the request context', async () => {
    const { get, seen } = nitro();
    const response = await get('/page');
    expect(seen.requestIds[0]).toBe(response.headers.get('x-request-id'));
  });

  it('answers build assets without the pipeline', async () => {
    const { get } = nitro();
    const response = await get('/assets/app-3f2a.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('does not hand the nonce to renders Nitro caches', async () => {
    routeRules['/cached'] = { cache: { swr: true, maxAge: 60 } };
    const { get, seen } = nitro();
    const response = await get('/cached');
    expect(response.status).toBe(200);
    expect(seen.facts['/cached']?.requestId).toBeTruthy();
    expect(seen.facts['/cached']?.nonce).toBeUndefined();
  });

  it('passes request bodies through to the application', async () => {
    const { get } = nitro();
    const response = await get('/api/echo', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    expect(await response.json()).toEqual({ hello: 'world' });
  });

  it('answers a failure that escapes the application with a JSON 500 that names the request', async () => {
    // Nitro turns handler errors into responses itself; this covers a rejection from `nitroApp.fetch` proper.
    const { get } = nitro();
    const response = await get('/api/boom', { headers: { accept: 'application/json' } });
    const body = (await response.json()) as { error: string; requestId: string };
    expect(response.status).toBe(500);
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toBe(response.headers.get('x-request-id'));
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });

  it('carries the platform properties Nitro’s presets set over to the forwarded request', async () => {
    const { nitroApp, seen } = nitro();
    const waitUntil = vi.fn();
    const request = new Request('https://app.example.com/page', {
      headers: { 'user-agent': BROWSER, accept: 'text/html' },
    }) as Nitro3Request;
    request.runtime = { name: 'cloudflare', cloudflare: { env: { KV: 1 }, context: { waitUntil } } };
    request.waitUntil = waitUntil;
    request.ip = '203.0.113.9';
    await nitroApp.fetch(request);
    const forwarded = seen.requests[0];
    expect(forwarded).not.toBe(request);
    expect(forwarded?.runtime?.cloudflare?.env).toEqual({ KV: 1 });
    expect(forwarded?.waitUntil).toBe(waitUntil);
    expect(forwarded?.ip).toBe('203.0.113.9');
  });
});

describe('createNitro3Fetch', () => {
  const config = loadConfig({ site: { name: 'nested' } });

  it('attaches the facts and passes through inside an outer Hypdriv runner', async () => {
    const inner = vi.fn(async (request: Request) => {
      void request;
      return new Response('ok');
    });
    const handler = createHandler({ config, host: 'nitro' });
    const fetch = createNitro3Fetch(inner, { handler });
    const request = new Request('https://app.example.com/page');
    const ctx = createContext({
      request,
      config,
      env: {},
      runner: 'worker',
      target: 'node',
    } as never);
    const response = await runWithContext(ctx, () => {
      expect(getCurrentContext()?.runner).toBe('worker');
      return fetch(request);
    });
    expect(await response.text()).toBe('ok');
    expect(inner).toHaveBeenCalledTimes(1);
    const forwarded = inner.mock.calls[0]?.[0] as unknown as Nitro3Request;
    const facts = forwarded.context?.[FACTS_KEY] as HypEventContext;
    expect(facts.runner).toBe('worker');
    expect(facts.requestId).toBe(ctx.id);
  });

  it('installs on nitroApp.fetch and keeps the original reachable', async () => {
    const original = vi.fn(async () => new Response('x'));
    const app = { fetch: original as (request: Request) => Promise<Response> };
    installNitro3Hook(app, { handler: createHandler({ config, host: 'nitro' }) });
    expect(app.fetch).not.toBe(original);
    await app.fetch(new Request('https://app.example.com/favicon.ico'));
    expect(original).toHaveBeenCalledTimes(1);
  });
});

describe('platformOf', () => {
  it('reads Cloudflare bindings, waitUntil and request.cf', () => {
    const waitUntil = vi.fn();
    const request = new Request('https://x/') as Nitro3Request;
    request.runtime = { cloudflare: { env: { A: 1 }, context: { waitUntil } } };
    request.cf = { country: 'US' };
    const platform = platformOf(request);
    expect(platform.env).toEqual({ A: 1 });
    expect(platform.cf).toEqual({ country: 'US' });
    platform.waitUntil?.(Promise.resolve());
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('reads Vercel’s waitUntil', () => {
    const waitUntil = vi.fn();
    const request = new Request('https://x/') as Nitro3Request;
    request.runtime = { vercel: { context: { waitUntil } } };
    platformOf(request).waitUntil?.(Promise.resolve());
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('is empty for a plain request', () => {
    expect(platformOf(new Request('https://x/') as Nitro3Request)).toEqual({});
  });
});

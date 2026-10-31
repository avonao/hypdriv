import type { HypDrivConfig } from '@hypdriv/core';
import { defineStage } from '@hypdriv/core';
import { createRequestHandler, RouterContextProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TEST_TOKEN, testBuild } from './__fixtures__/build';
import { createServerEntry, hypdrivMiddleware, PRERENDER_HEADER } from './server';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const config: HypDrivConfig = {
  site: { name: 'rr-test' },
  security: { rateLimit: [{ id: 'login', match: '/login', limit: 1, window: '1m', key: ['ip'] }] },
  redirects: { rules: [{ from: '/old', to: '/new', status: 307 }] },
};

function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://app.example${path}`, {
    ...init,
    headers: {
      'user-agent': UA,
      accept: 'text/html',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'document',
      ...init.headers,
    },
  });
}

function entry(options: { token?: string } = {}) {
  return createServerEntry({
    build: testBuild({ middleware: { config, manifest: null, prerenderToken: options.token ?? TEST_TOKEN } }),
    config,
    manifest: null,
    prerenderToken: options.token ?? TEST_TOKEN,
  });
}

const nonces = (html: string) => [...new Set([...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]))];
const testId = (html: string, id: string) => new RegExp(`data-testid="${id}">([^<]*)<`).exec(html)?.[1];

describe('createServerEntry', () => {
  it('runs the pipeline around documents and puts the CSP nonce on every script', async () => {
    const res = await entry().fetch(request('/page'), { ip: '198.51.100.7' });
    expect(res.status).toBe(200);
    const html = await res.text();
    const policy = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(nonces(html)).toEqual([nonce]);
    expect(html).toMatch(/<script nonce="[^"]+"/);
    // Loaders run inside the request context: hyp() and the router context see the same request.
    expect(testId(html, 'request-id')).toBe(res.headers.get('x-request-id'));
    expect(testId(html, 'nonce')).toBe(nonce);
    expect(testId(html, 'context')).toBe('true');
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('server-timing')).toContain('csp;desc="nonce"');
  });

  it('covers resource routes, 404s and /_hypdriv/*', async () => {
    const server = entry();
    const api = await server.fetch(request('/api/ping', { headers: { accept: 'application/json' } }));
    const body = (await api.json()) as { requestId: string; runner: string };
    expect(body.requestId).toBe(api.headers.get('x-request-id'));
    expect(body.runner).toBe('host');
    const missing = await server.fetch(request('/nope'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toBeTruthy();
    expect(missing.headers.get('content-security-policy')).toContain("'nonce-");
    const health = await server.fetch(request('/_hypdriv/health'));
    const facts = (await health.json()) as { runner: string; ok: boolean };
    expect(facts).toMatchObject({ ok: true, runner: 'host' });
  });

  it('serves static files through the pipeline before React Router', async () => {
    const res = await entry().fetch(request('/about'), {
      assets: (req) =>
        new URL(req.url).pathname === '/about'
          ? new Response('<!doctype html><title>About</title><script>1</script>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          : null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(await res.text()).toContain('<title>About</title>');
  });

  it('skips the pipeline for the build’s prerender requests only', async () => {
    const server = entry();
    const prerender = await server.fetch(
      request('/page', { headers: { 'x-react-router-prerender': 'yes', [PRERENDER_HEADER]: TEST_TOKEN } }),
    );
    expect(prerender.status).toBe(200);
    expect(prerender.headers.get('x-request-id')).toBeNull();
    expect(prerender.headers.get('content-security-policy')).toBeNull();
    const html = await prerender.text();
    expect(nonces(html)).toEqual([]);
    expect(testId(html, 'request-id')).toBe('none');

    // React Router's own headers and a wrong token are ordinary requests.
    const spoofed = await server.fetch(
      request('/page', {
        headers: { 'x-react-router-prerender': 'yes', [PRERENDER_HEADER]: 'a'.repeat(64) },
      }),
    );
    expect(spoofed.headers.get('x-request-id')).toBeTruthy();
    expect(spoofed.headers.get('content-security-policy')).toContain("'nonce-");
  });

  it('never skips when the build carries no token (production output)', async () => {
    const res = await entry({ token: '' }).fetch(request('/page', { headers: { [PRERENDER_HEADER]: '' } }));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('applies rate limits to data requests and turns pipeline redirects into single-fetch redirects', async () => {
    const server = entry();
    const first = await server.fetch(request('/login'), { ip: '203.0.113.9' });
    expect(first.status).toBe(200);
    const data = await server.fetch(request('/login.data', { method: 'POST' }), { ip: '203.0.113.9' });
    expect(data.status).toBe(429);

    const redirect = await server.fetch(request('/old.data'));
    expect(redirect.status).toBe(204);
    expect(redirect.headers.get('x-remix-redirect')).toBe('https://app.example/new');
    expect(redirect.headers.get('x-remix-status')).toBe('307');
    expect(redirect.headers.get('x-remix-reload-document')).toBe('true');
    const document = await server.fetch(request('/old'));
    expect(document.status).toBe(307);
    expect(document.headers.get('location')).toBe('https://app.example/new');
    // React Router's own redirects for data requests (encoded in the single-fetch payload) are left alone.
    const appRedirect = await server.fetch(request('/go.data'));
    expect(appRedirect.status).toBe(202);
    expect(appRedirect.headers.get('x-remix-redirect')).toBeNull();
    expect(await appRedirect.text()).toContain('/page');
  });
});

describe('hypdrivMiddleware', () => {
  const handlerFor = (options: Parameters<typeof testBuild>[0] = {}) =>
    createRequestHandler(testBuild(options), 'production');

  it('runs the pipeline for routed requests when no outer runner exists', async () => {
    const rr = handlerFor({ middleware: { config, manifest: null, prerenderToken: TEST_TOKEN } });
    const res = await rr(request('/page'), new RouterContextProvider());
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonces(html)).toEqual([nonce]);
    expect(testId(html, 'context')).toBe('true');
    // No route matches: React Router answers without the middleware.
    const missing = await rr(request('/nope'), new RouterContextProvider());
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toBeNull();
  });

  it('throws pipeline redirects so React Router formats them', async () => {
    const moved: HypDrivConfig = { redirects: { rules: [{ from: '/page', to: '/new', status: 307 }] } };
    const rr = handlerFor({ middleware: { config: moved, manifest: null, prerenderToken: TEST_TOKEN } });
    const doc = await rr(request('/page'), new RouterContextProvider());
    expect(doc.status).toBe(307);
    expect(doc.headers.get('location')).toBe('https://app.example/new');
    const data = await rr(request('/page.data'), new RouterContextProvider());
    // React Router encodes the thrown redirect in its single-fetch payload.
    expect(data.status).toBe(202);
    expect(await data.text()).toContain('https://app.example/new');
  });

  it('passes through inside an outer Hypdriv runner (the stages run once)', async () => {
    let inner = 0;
    let outer = 0;
    const counter = (count: () => void) =>
      defineStage({
        name: 'counter',
        pre() {
          count();
        },
      });
    const server = createServerEntry({
      build: testBuild({
        middleware: {
          config,
          manifest: null,
          prerenderToken: TEST_TOKEN,
          stages: (defaults) => [...defaults, counter(() => inner++)],
        },
      }),
      config,
      manifest: null,
      prerenderToken: TEST_TOKEN,
      stages: (defaults) => [...defaults, counter(() => outer++)],
    });
    const res = await server.fetch(request('/page'));
    expect(res.status).toBe(200);
    expect(outer).toBe(1);
    expect(inner).toBe(0);
    // The router context still carries the request context.
    expect(testId(await res.text(), 'context')).toBe('true');
  });

  it('skips the build’s prerender requests', async () => {
    const rr = handlerFor({ middleware: { config, manifest: null, prerenderToken: TEST_TOKEN } });
    const res = await rr(
      request('/page', { headers: { 'x-react-router-prerender': 'yes', [PRERENDER_HEADER]: TEST_TOKEN } }),
      new RouterContextProvider(),
    );
    expect(res.headers.get('x-request-id')).toBeNull();
    expect(nonces(await res.text())).toEqual([]);
  });

  it('loads config, manifest and token from the virtual modules by default', async () => {
    const rr = createRequestHandler(testBuild({ middleware: {}, extraMiddleware: [] }), 'production');
    const res = await rr(request('/page'), new RouterContextProvider());
    expect(res.headers.get('x-request-id')).toBeTruthy();
    // The fixture token of `virtual:hypdriv/react-router` marks prerender requests.
    const prerender = await rr(
      request('/page', { headers: { [PRERENDER_HEADER]: 'f'.repeat(64) } }),
      new RouterContextProvider(),
    );
    expect(prerender.headers.get('x-request-id')).toBeNull();
  });

  it('exposes hypdrivMiddleware as a React Router middleware function', () => {
    expect(typeof hypdrivMiddleware()).toBe('function');
  });
});

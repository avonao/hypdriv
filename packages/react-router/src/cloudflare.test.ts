import { emptyManifest, type HypDrivConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { TEST_TOKEN, testBuild } from './__fixtures__/build';
import { reactRouterWorker } from './cloudflare';
import { PRERENDER_HEADER } from './shared';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const config: HypDrivConfig = {
  site: { name: 'rr-worker-test' },
  redirects: { rules: [{ from: '/old', to: '/new', status: 307 }] },
};
const ctx = { waitUntil: () => undefined };

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example${path}`, {
    headers: {
      'user-agent': UA,
      accept: 'text/html',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'document',
      ...headers,
    },
  });
}

/** A Workers Static Assets binding with a prerendered `/about` and a SPA shell. */
function assetsBinding() {
  const seen: string[] = [];
  return {
    seen,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === '/about')
        return new Response('<!doctype html><title>About</title><script>boot()</script>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // A static `_headers` rule: replaced by the request's own policy.
            'content-security-policy': "script-src 'none'",
            'x-hypdriv-csp': 'hash',
          },
        });
      if (path === '/__spa-fallback')
        return new Response('<!doctype html><title>Shell</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      return new Response('Not Found', { status: 404 });
    },
  };
}

function worker(ssr = true) {
  return reactRouterWorker({
    config,
    manifest: emptyManifest(),
    build: testBuild({ ssr, middleware: { config, manifest: null, prerenderToken: TEST_TOKEN } }),
    prerenderToken: TEST_TOKEN,
  });
}

describe('reactRouterWorker', () => {
  it('runs the Worker shell around React Router; the root middleware passes through', async () => {
    const ASSETS = assetsBinding();
    const res = await worker().fetch(request('/page'), { ASSETS }, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect([...new Set([...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]))]).toEqual([nonce]);
    expect(/data-testid="request-id">([^<]*)</.exec(html)?.[1]).toBe(res.headers.get('x-request-id'));
    expect(ASSETS.seen).toEqual(['/page']);
    const health = (await (await worker().fetch(request('/_hypdriv/health'), { ASSETS }, ctx)).json()) as {
      runner: string;
    };
    expect(health.runner).toBe('worker');
  });

  it('serves static files from the assets binding with the request’s policy', async () => {
    const res = await worker().fetch(request('/about'), { ASSETS: assetsBinding() }, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>About</title>');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).not.toBe("script-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain('script-src');
  });

  it('answers 404s and resource routes through the shell', async () => {
    const ASSETS = assetsBinding();
    const missing = await worker().fetch(request('/nope'), { ASSETS }, ctx);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toBeTruthy();
    const api = await worker().fetch(request('/api/ping', { accept: 'application/json' }), { ASSETS }, ctx);
    expect(((await api.json()) as { runner: string }).runner).toBe('worker');
  });

  it('lets the build’s prerender requests skip the shell and the assets', async () => {
    const ASSETS = assetsBinding();
    const res = await worker().fetch(
      request('/page', { 'x-react-router-prerender': 'yes', [PRERENDER_HEADER]: TEST_TOKEN }),
      { ASSETS },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeNull();
    expect(await res.text()).not.toContain('nonce=');
    expect(ASSETS.seen).toEqual([]);
    const spoofed = await worker().fetch(
      request('/page', { [PRERENDER_HEADER]: 'b'.repeat(64) }),
      { ASSETS },
      ctx,
    );
    expect(spoofed.headers.get('x-request-id')).toBeTruthy();
  });

  it('serves the SPA shell for unknown navigations of single-page apps', async () => {
    const ASSETS = assetsBinding();
    const res = await worker(false).fetch(request('/account/settings'), { ASSETS }, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Shell</title>');
    expect(ASSETS.seen).toEqual(['/account/settings', '/__spa-fallback']);
  });

  it('turns the pipeline’s redirects of data requests into single-fetch redirects', async () => {
    const res = await worker().fetch(request('/old.data'), { ASSETS: assetsBinding() }, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe('https://app.example/new');
    const doc = await worker().fetch(request('/old'), { ASSETS: assetsBinding() }, ctx);
    expect(doc.status).toBe(307);
  });

  it('keeps the shell’s scheduled, queue and email handlers', () => {
    const w = worker();
    expect(typeof w.scheduled).toBe('function');
    expect(typeof w.queue).toBe('function');
    expect(typeof w.email).toBe('function');
  });
});

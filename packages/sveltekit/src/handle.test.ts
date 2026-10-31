import { emptyManifest, getCurrentContext, type HypManifest, routePatternToRegex } from '@hypdriv/core';
import { createHandler, hyp, nonce } from '@hypdriv/runtime';
import { describe, expect, it, vi } from 'vitest';
import { createSvelteKitHandle, platformInput, type RequestEventLike } from './handle';

const manifest: HypManifest = emptyManifest({
  buildId: 'b1',
  framework: { name: 'sveltekit', version: '3.1.1', bundler: 'vite', bundlerVersion: '8.3.5' },
  routes: [
    {
      id: 'page:/ssr',
      pathname: '/ssr',
      regex: routePatternToRegex('/ssr'),
      kind: 'page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
});

interface TestEvent extends RequestEventLike {
  url: URL;
  route: { id: string | null };
}

function event(path: string, init: RequestInit = {}, extra: Partial<TestEvent> = {}): TestEvent {
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0',
      accept: 'text/html',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return {
    request,
    url: new URL(request.url),
    route: { id: path },
    getClientAddress: () => '198.51.100.7',
    ...extra,
  };
}

const page = (body: string, headers: Record<string, string> = {}) =>
  new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });

function setup(
  options: { building?: boolean; csp?: Parameters<typeof createSvelteKitHandle>[0]['csp'] } = {},
) {
  let building = options.building ?? false;
  const created = createSvelteKitHandle<TestEvent>({
    config: {},
    manifest,
    csp: options.csp ?? null,
    building: () => building,
    target: 'node',
    development: false,
  });
  return { ...created, setBuilding: (v: boolean) => (building = v) };
}

describe('createSvelteKitHandle', () => {
  it('passes through untouched while SvelteKit builds and prerenders', async () => {
    const { handle } = setup({ building: true });
    const e = event('/ssr');
    // Reading the search params of a prerender request throws in SvelteKit: the hook must not touch them.
    Object.defineProperty(e.url, 'searchParams', {
      get() {
        throw new Error('url_search_unavailable_prerender');
      },
    });
    const resolve = vi.fn(async (seen: TestEvent) => {
      expect(seen).toBe(e);
      expect(getCurrentContext()).toBeUndefined();
      return page('<script>x()</script>');
    });
    const response = await handle({ event: e, resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('runs the pipeline around resolve: request id, security headers, nonce CSP injected into the page', async () => {
    const { handle } = setup();
    let inside: { nonce?: string | undefined; runner?: string | undefined; route?: string | null } = {};
    const response = await handle({
      event: event('/ssr'),
      resolve: async () => {
        inside = { nonce: nonce(), runner: hyp()?.runner, route: hyp()?.route };
        return page('<script>start()</script><link rel="modulepreload" href="/_app/a.js">');
      },
    });
    const body = await response.text();
    expect(inside.runner).toBe('host');
    expect(inside.route).toBe('page:/ssr');
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${inside.nonce}'`);
    expect(body).toContain(`<script nonce="${inside.nonce}">start()</script>`);
    expect(body).toContain(`<link rel="modulepreload" href="/_app/a.js" nonce="${inside.nonce}">`);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it("adopts SvelteKit's own policy: one header, Hypdriv's nonce everywhere, SvelteKit's directives kept", async () => {
    const { handle } = setup({
      csp: { mode: 'auto', directives: { 'script-src': ['self', 'https://js.example.com'] } },
    });
    let hypNonce: string | undefined;
    const response = await handle({
      event: event('/ssr'),
      resolve: async () => {
        hypNonce = nonce();
        return page(
          `<script nonce="KITNONCE1==">boot()</script><script nonce="${hypNonce}">app()</script><script nonce="KITNONCE1==">stream()</script>`,
          { 'content-security-policy': "script-src 'self' 'nonce-KITNONCE1==' https://js.example.com" },
        );
      },
    });
    const body = await response.text();
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(body).not.toContain('KITNONCE1==');
    expect(body.match(new RegExp(`nonce="${hypNonce}"`, 'g'))).toHaveLength(3);
    expect(policy).toContain(`'nonce-${hypNonce}'`);
    expect(policy).toContain('https://js.example.com');
    expect(policy).not.toContain('KITNONCE1');
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
  });

  it('hands SvelteKit the forwarded request, body included', async () => {
    const { handle } = setup();
    const e = event('/form', {
      method: 'POST',
      body: 'name=Ada',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const response = await handle({
      event: e,
      resolve: async (seen) => {
        expect(seen).not.toBe(e);
        expect(seen.url).toBe(e.url);
        expect(seen.request.headers.get('x-hypdriv-runner')).toBe('host');
        const form = await seen.request.formData();
        return Response.json({ name: form.get('name') });
      },
    });
    expect(await response.json()).toEqual({ name: 'Ada' });
  });

  it('passes through for SvelteKit sub-requests and inside an outer Hypdriv runner', async () => {
    const { handle } = setup();
    const sub = await handle({
      event: event('/api/data', {}, { isSubRequest: true }),
      resolve: async () => Response.json({ ok: true }),
    });
    expect(sub.headers.get('x-request-id')).toBeNull();

    // Hypdriv's Node server (or the Worker shell) already runs the pipeline around SvelteKit.
    const outer = createHandler({ config: {}, manifest, target: 'node', development: false });
    let runs = 0;
    const response = await outer(
      new Request('https://example.com/ssr', { headers: event('/ssr').request.headers }),
      {
        upstream: () =>
          handle({
            event: event('/ssr'),
            resolve: async () => {
              runs++;
              return page(`<script nonce="KIT2">x()</script>`, {
                'content-security-policy': "script-src 'nonce-KIT2'",
              });
            },
          }),
      },
    );
    const body = await response.text();
    const outerNonce = /nonce="([^"]+)"/.exec(body)?.[1];
    expect(runs).toBe(1);
    expect(outerNonce).toBeTruthy();
    expect(outerNonce).not.toBe('KIT2');
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${outerNonce}'`);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('answers /_hypdriv/* before SvelteKit', async () => {
    const { handle } = setup();
    const resolve = vi.fn(async () => page('app'));
    const response = await handle({ event: event('/_hypdriv/health'), resolve });
    expect(resolve).not.toHaveBeenCalled();
    const health = (await response.json()) as { framework: string; runner: string };
    expect(health.framework).toBe('SvelteKit 3.1.1 (Vite 8.3.5)');
    expect(health.runner).toBe('host');
  });

  it('resumes the pipeline once the build is over (the flag is read per request)', async () => {
    const { handle, setBuilding } = setup({ building: true });
    const first = await handle({ event: event('/ssr'), resolve: async () => page('x') });
    expect(first.headers.get('x-request-id')).toBeNull();
    setBuilding(false);
    const second = await handle({ event: event('/ssr'), resolve: async () => page('x') });
    expect(second.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('platformInput', () => {
  it('reads cf, bindings and waitUntil an adapter exposes', () => {
    const waitUntil = vi.fn();
    const e = event('/', {}, { platform: { env: { KV: {} }, context: { waitUntil } } });
    (e.request as unknown as { cf: unknown }).cf = { country: 'US', colo: 'SJC' };
    const input = platformInput(e, false);
    expect(input.cf).toEqual({ country: 'US', colo: 'SJC' });
    expect(input.env).toEqual({ KV: {} });
    const p = Promise.resolve();
    input.waitUntil?.(p);
    expect(waitUntil).toHaveBeenCalledWith(p);
    expect(input.ip).toBeUndefined();
  });

  it("uses SvelteKit's client address on Node (adapter-node, dev server) only", () => {
    expect(platformInput(event('/', {}, { platform: { req: {} } }), false).ip).toBe('198.51.100.7');
    expect(platformInput(event('/'), true).ip).toBe('198.51.100.7');
    expect(platformInput(event('/'), false).ip).toBeUndefined();
    const failing = event(
      '/',
      {},
      {
        platform: { req: {} },
        getClientAddress: () => {
          throw new Error('unsupported');
        },
      },
    );
    expect(platformInput(failing, true).ip).toBeUndefined();
  });
});

import { emptyManifest, type HypManifest, routeId, routePatternToRegex } from '@hypdriv/core';
import { ensureContextStore } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformInput, type WakuServerEntry, type WrapOptions, wrapEntry } from './entry';
import { wrapNodeEntry } from './node';
import { hyp, nonce } from './server';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const page = (pathname: string, extra: Partial<HypManifest['routes'][number]> = {}) => ({
  id: routeId('page', pathname),
  pathname,
  regex: routePatternToRegex(pathname),
  kind: 'page' as const,
  classification: 'dynamic' as const,
  runtime: 'nodejs' as const,
  dynamic: false,
  assets: { js: [], css: [], fonts: [] },
  ...extra,
});

const manifest = emptyManifest({
  buildId: 'test',
  framework: { name: 'waku', version: '1.0.0-rc.4' },
  routes: [page('/'), page('/account')],
  staticFiles: { count: 1, immutablePrefixes: ['/assets/'] },
});

const options = (overrides: Partial<WrapOptions> = {}): WrapOptions => ({
  config: { site: { name: 'waku-test' } },
  manifest,
  target: 'node',
  development: false,
  ...overrides,
});

interface Seen {
  request: Request;
  args: unknown[];
  nonce: string | undefined;
  route: string | null;
}

/** A Waku-shaped entry: an HTML page with Waku's two inline scripts, plus a plain text and a static file. */
function fakeEntry(seen: Seen[] = []): WakuServerEntry {
  return {
    fetch: async (request: Request, ...args: unknown[]) => {
      seen.push({ request, args, nonce: nonce(), route: hyp()?.route ?? null });
      const { pathname } = new URL(request.url);
      if (pathname === '/assets/app-3f2a9c.js')
        return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
      if (pathname === '/assets/cached.js')
        return new Response('x', {
          headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' },
        });
      if (pathname === '/assets/gone.js') return new Response('nope', { status: 404 });
      return new Response(
        '<!DOCTYPE html><html><head><title>t</title></head><body><div>hi</div><script id="_R_">globalThis.__WAKU_HYDRATE__ = true;</script><script>(self.__FLIGHT_DATA||=[]).push("0:{}")</script></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8', 'x-powered-by': 'waku-test' } },
      );
    },
    build: async () => undefined,
    buildOptions: { distDir: 'dist' },
    buildEnhancers: ['waku/adapters/node-build-enhancer'],
    serve: () => undefined,
  };
}

beforeAll(async () => {
  await ensureContextStore();
});

describe('wrapEntry', () => {
  it('runs the pipeline around Waku and keeps the rest of the entry', async () => {
    const entry = fakeEntry();
    const wrapped = wrapEntry(entry, options());
    expect(wrapped.build).toBe(entry.build);
    expect(wrapped.buildOptions).toEqual({ distDir: 'dist' });
    expect(wrapped.buildEnhancers).toEqual(['waku/adapters/node-build-enhancer']);
    expect(wrapped.serve).toBe(entry.serve);

    const response = await wrapped.fetch(new Request('https://shop.example/account', { headers: BROWSER }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('script-src');
  });

  it('puts the request nonce on Waku inline scripts and hands it to server code', async () => {
    const seen: Seen[] = [];
    const wrapped = wrapEntry(fakeEntry(seen), options());
    const response = await wrapped.fetch(new Request('https://shop.example/', { headers: BROWSER }));
    const csp = response.headers.get('content-security-policy') ?? '';
    const token = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(token).toBeTruthy();
    const html = await response.text();
    // Waku writes its inline scripts without a nonce; the pipeline adds it to every one of them.
    expect(html).toContain(`<script id="_R_" nonce="${token}">`);
    expect(html).toContain(`<script nonce="${token}">(self.__FLIGHT_DATA`);
    expect(seen[0]?.nonce).toBe(token);
    expect(seen[0]?.route).toBe(routeId('page', '/'));
  });

  it('answers /_hypdriv/* itself and passes other requests on', async () => {
    const seen: Seen[] = [];
    const wrapped = wrapEntry(fakeEntry(seen), options());
    const health = await wrapped.fetch(
      new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }),
    );
    expect(health.status).toBe(200);
    expect(seen).toHaveLength(0);
    await wrapped.fetch(new Request('https://shop.example/', { headers: BROWSER }));
    expect(seen).toHaveLength(1);
  });

  it('strips client-supplied x-hypdriv-* headers before Waku sees the request', async () => {
    const seen: Seen[] = [];
    const wrapped = wrapEntry(fakeEntry(seen), options());
    await wrapped.fetch(
      new Request('https://shop.example/', {
        headers: {
          ...BROWSER,
          'x-hypdriv-runner': 'forged',
          'x-hypdriv-route': 'forged',
          'x-nonce': 'forged',
        },
      }),
    );
    const headers = seen[0]?.request.headers;
    expect(headers?.get('x-hypdriv-runner')).not.toBe('forged');
    expect(headers?.get('x-hypdriv-route')).not.toBe('forged');
    expect(headers?.get('x-nonce')).not.toBe('forged');
  });

  it("forwards the server's extra arguments (Node bindings, Workers env and context) to Waku", async () => {
    const seen: Seen[] = [];
    const wrapped = wrapEntry(fakeEntry(seen), options());
    const bindings = { incoming: { socket: { remoteAddress: '203.0.113.9' } }, outgoing: {} };
    await wrapped.fetch(new Request('https://shop.example/', { headers: BROWSER }), bindings);
    expect(seen[0]?.args).toEqual([bindings]);
  });

  it('applies the configured redirects before Waku is called', async () => {
    const seen: Seen[] = [];
    const wrapped = wrapEntry(
      fakeEntry(seen),
      options({
        config: {
          site: { name: 'waku-test' },
          redirects: { rules: [{ from: '/old', to: '/account', status: 308 }] },
        },
      }),
    );
    const response = await wrapped.fetch(
      new Request('https://shop.example/old', { headers: BROWSER, redirect: 'manual' }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toContain('/account');
    expect(seen).toHaveLength(0);
  });
});

describe('platformInput', () => {
  const config = { security: { trustedProxies: 0 } };

  it('reads the socket address of a Node server', () => {
    const request = new Request('https://shop.example/');
    const args = [{ incoming: { socket: { remoteAddress: '198.51.100.7' } }, outgoing: {} }];
    expect(platformInput(request, args, config as never)).toEqual({ ip: '198.51.100.7' });
  });

  it('reports the IPv4 address of a dual-stack socket (::ffff:a.b.c.d) as plain IPv4', () => {
    const request = new Request('https://shop.example/');
    const mapped = [{ incoming: { socket: { remoteAddress: '::ffff:203.0.113.9' } }, outgoing: {} }];
    expect(platformInput(request, mapped, config as never)).toEqual({ ip: '203.0.113.9' });
    const v6 = [{ incoming: { socket: { remoteAddress: '2001:db8::1' } }, outgoing: {} }];
    expect(platformInput(request, v6, config as never)).toEqual({ ip: '2001:db8::1' });
  });

  it('leaves the address to the forwarded headers behind proxies', () => {
    const request = new Request('https://shop.example/');
    const args = [{ incoming: { socket: { remoteAddress: '10.0.0.1' } }, outgoing: {} }];
    expect(platformInput(request, args, { security: { trustedProxies: 1 } } as never)).toEqual({});
  });

  it('reads Cloudflare bindings, waitUntil and request.cf', () => {
    const waitUntil = (promise: Promise<unknown>) => void promise;
    const env = { GREETING: 'hello' };
    const request = new Request('https://shop.example/');
    Object.defineProperty(request, 'cf', { value: { country: 'US' } });
    const input = platformInput(request, [env, { waitUntil }], config as never);
    expect(input.env).toBe(env);
    expect(typeof input.waitUntil).toBe('function');
    expect(input.cf).toEqual({ country: 'US' });
  });
});

describe('wrapNodeEntry', () => {
  it('gives content-hashed assets the immutable cache header', async () => {
    const wrapped = wrapNodeEntry(fakeEntry(), options());
    const asset = await wrapped.fetch(new Request('https://shop.example/assets/app-3f2a9c.js'));
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('console.log(1)');
  });

  it('keeps an explicit cache header, and leaves pages, errors and other methods alone', async () => {
    const wrapped = wrapNodeEntry(fakeEntry(), options());
    const own = await wrapped.fetch(new Request('https://shop.example/assets/cached.js'));
    expect(own.headers.get('cache-control')).toBe('no-cache');
    const pageResponse = await wrapped.fetch(new Request('https://shop.example/', { headers: BROWSER }));
    expect(pageResponse.headers.get('cache-control')).not.toContain('immutable');
    const missing = await wrapped.fetch(new Request('https://shop.example/assets/gone.js'));
    expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
    const post = await wrapped.fetch(
      new Request('https://shop.example/assets/app-3f2a9c.js', { method: 'POST' }),
    );
    expect(post.headers.get('cache-control') ?? '').not.toContain('immutable');
  });
});

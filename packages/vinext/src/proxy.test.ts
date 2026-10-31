import { emptyManifest } from '@hypdriv/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueWith, createProxy } from './proxy';
import { PRERENDER_TOKEN_ENV, wrapAppHandler } from './runtime';

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const get = (path: string) =>
  new Request(`https://example.com${path}`, {
    headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US' },
  });
const event = { waitUntil: () => undefined };
const manifest = emptyManifest({ framework: { name: 'vinext', version: '1.4.0' } });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createProxy', () => {
  it('runs the stages before vinext and forwards Hypdriv’s request headers', async () => {
    const proxy = createProxy({ config: {}, manifest, target: 'node' });
    const response = await proxy(get('/account'), event);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    // The request headers vinext continues with (NextResponse.next({ request: { headers } })).
    const overridden = response.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden).toContain('content-security-policy');
    expect(response.headers.get('x-middleware-request-content-security-policy')).toContain("'nonce-");
    expect(response.headers.get('content-security-policy')).toContain("'nonce-");
    const health = await proxy(get('/_hypdriv/health'), event);
    expect(((await health.json()) as { runner: string }).runner).toBe('proxy');
  });

  it('passes through inside the plugin’s request hook and during the build’s prerender', async () => {
    const proxy = createProxy({ config: {}, manifest, target: 'node' });
    const hooked = wrapAppHandler(
      async (_request: Request) => {
        const inner = await proxy(get('/account'), event);
        expect(inner.headers.get('x-request-id')).toBeNull();
        expect(inner.headers.get('x-middleware-next')).toBe('1');
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
      { config: {}, manifest, target: 'node' },
    );
    expect((await hooked(get('/account'))).headers.get('x-request-id')).toBeTruthy();

    vi.stubEnv('VINEXT_PRERENDER', '1');
    vi.stubEnv(PRERENDER_TOKEN_ENV, 'tok');
    vi.stubGlobal('__HYPDRIV_VINEXT_PRERENDER_TOKEN__', 'tok');
    const prerender = await proxy(get('/account'), event);
    expect(prerender.headers.get('x-request-id')).toBeNull();
  });

  it('continues with the forwarded headers', async () => {
    const response = await continueWith(
      new Request('https://example.com/', { headers: { 'x-hypdriv-flags': 'a' } }),
    );
    expect(response.headers.get('x-middleware-request-x-hypdriv-flags')).toBe('a');
  });
});

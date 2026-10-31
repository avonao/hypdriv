import { emptyManifest, type HypManifest, type HypRoute, routePatternToRegex } from '@hypdriv/core';
import { hyp } from '@hypdriv/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBuildPrerender,
  nativeRequest,
  PRERENDER_TOKEN_ENV,
  privateNonceDocument,
  upstreamRequest,
  wrapAppHandler,
} from './runtime';

const route = (pathname: string, classification: HypRoute['classification']): HypRoute => ({
  id: `page:${pathname}`,
  pathname,
  regex: routePatternToRegex(pathname),
  kind: 'page',
  classification,
  runtime: 'nodejs',
  dynamic: false,
  assets: { js: [], css: [], fonts: [] },
});

const manifest: HypManifest = emptyManifest({
  framework: { name: 'vinext', version: '1.4.0', bundler: 'vite' },
  routes: [route('/', 'static'), route('/news', 'isr'), route('/account', 'dynamic')],
  csp: { 'page:/': { scriptHashes: ["'sha256-home'"], styleHashes: [] } },
});

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://example.com${path}`, {
    headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US', ...headers },
  });

/** A stand-in for vinext's App Router handler: applies the nonce of the request's CSP like vinext does. */
function vinextHandler(seen: Request[] = []) {
  const handler = async (request: Request, _ctx?: unknown): Promise<Response> => {
    seen.push(request);
    const nonce = /'nonce-([^']+)'/.exec(request.headers.get('content-security-policy') ?? '')?.[1];
    const attr = nonce ? ` nonce="${nonce}"` : '';
    const context = hyp();
    return new Response(
      `<!doctype html><html><head><script${attr}>self.__next_f=[]</script></head><body><p>${context?.requestId ?? 'none'}|${context?.runner ?? 'none'}</p><script type="module" src="/_next/static/chunks/a.js"${attr}></script></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  };
  handler.handleResponseStage = async () => new Response('stage');
  return handler;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('wrapAppHandler', () => {
  it('runs the Drivetrain around vinext and hands vinext the nonce policy for dynamic pages', async () => {
    const seen: Request[] = [];
    const wrapped = wrapAppHandler(vinextHandler(seen), { config: {}, manifest, target: 'node' });
    const response = await wrapped(get('/account'), { waitUntil: () => undefined });
    const body = await response.text();
    const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(seen[0]?.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
    expect(body).toContain(`<script nonce="${nonce}">self.__next_f=[]</script>`);
    // Application code sees the request context.
    const requestId = response.headers.get('x-request-id');
    expect(body).toContain(`<p>${requestId}|host</p>`);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('server-timing')).toContain('total');
  });

  it('serves static pages with the build’s hashes and caches-friendly requests', async () => {
    const seen: Request[] = [];
    const wrapped = wrapAppHandler(vinextHandler(seen), { config: {}, manifest, target: 'node' });
    const response = await wrapped(get('/'));
    expect(response.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(response.headers.get('content-security-policy')).toContain("'sha256-home'");
    expect(seen[0]?.headers.has('content-security-policy')).toBe(false);
  });

  it('keeps vinext’s page cache for ISR pages and injects the nonce into the cached document', async () => {
    const seen: Request[] = [];
    const wrapped = wrapAppHandler(vinextHandler(seen), { config: {}, manifest, target: 'node' });
    const response = await wrapped(get('/news'));
    const body = await response.text();
    const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    // vinext would never cache a nonce-bearing render: the policy is not forwarded, the nonce is injected.
    expect(seen[0]?.headers.has('content-security-policy')).toBe(false);
    expect(body).toContain(`<script nonce="${nonce}">self.__next_f=[]</script>`);
    expect(body).toContain(`src="/_next/static/chunks/a.js" nonce="${nonce}"`);
  });

  it('keeps documents with an injected nonce out of shared caches', async () => {
    const cached = async (_request: Request) =>
      new Response('<html><body><script>x()</script></body></html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 's-maxage=60, stale-while-revalidate',
          'cdn-cache-control': 'max-age=60',
        },
      });
    const wrapped = wrapAppHandler(cached, { config: {}, manifest, target: 'node' });
    const isr = await wrapped(get('/news'));
    expect(isr.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(isr.headers.get('cache-control')).toBe('private, no-store');
    expect(isr.headers.has('cdn-cache-control')).toBe(false);
    // A hash-policy document stays cacheable.
    const home = await wrapped(get('/'));
    expect(home.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(home.headers.get('cache-control')).toBe('s-maxage=60, stale-while-revalidate');
    expect(
      privateNonceDocument(new Response('{}', { headers: { 'x-hypdriv-csp': 'nonce' } })).headers.has(
        'cache-control',
      ),
    ).toBe(false);
  });

  it('answers HypDriv’s internal routes with the vinext label', async () => {
    const app = vi.fn(vinextHandler());
    const wrapped = wrapAppHandler(app, { config: {}, manifest, target: 'node' });
    const response = await wrapped(get('/_hypdriv/health'));
    const health = (await response.json()) as { runner: string; framework: string };
    expect(health.runner).toBe('host');
    expect(health.framework).toContain('vinext 1.4.0');
    expect(app).not.toHaveBeenCalled();
  });

  it('bypasses the pipeline for the build’s own prerender requests only', async () => {
    const seen: Request[] = [];
    const wrapped = wrapAppHandler(vinextHandler(seen), {
      config: {},
      manifest,
      target: 'node',
      prerenderToken: 'token-1',
    });
    vi.stubEnv('VINEXT_PRERENDER', '1');
    vi.stubEnv(PRERENDER_TOKEN_ENV, 'token-1');
    const prerendered = await wrapped(get('/account'));
    expect(prerendered.headers.get('x-request-id')).toBeNull();
    expect(seen[0]?.headers.has('content-security-policy')).toBe(false);
    // Another build's token (or none) never skips.
    vi.stubEnv(PRERENDER_TOKEN_ENV, 'token-2');
    expect((await wrapped(get('/account'))).headers.get('x-request-id')).toBeTruthy();
    vi.stubEnv(PRERENDER_TOKEN_ENV, 'token-1');
    vi.stubEnv('VINEXT_PRERENDER', '0');
    expect((await wrapped(get('/account'))).headers.get('x-request-id')).toBeTruthy();
    expect(isBuildPrerender(null)).toBe(false);
  });

  it('keeps the handler’s own properties, resolves loaders and leaves other shapes alone', async () => {
    const original = vinextHandler();
    const wrapped = wrapAppHandler(original, { config: {}, manifest, target: 'node' });
    expect(wrapped.handleResponseStage).toBe(original.handleResponseStage);
    expect(typeof wrapped.hypdriv).toBe('function');
    const multiStage = { handleResponseStage: original.handleResponseStage };
    expect(wrapAppHandler(multiStage, { config: {}, manifest })).toBe(multiStage);
    let loads = 0;
    const lazy = wrapAppHandler(
      async () => {
        loads++;
        return vinextHandler();
      },
      { config: {}, manifest, target: 'node' },
      { load: true },
    );
    const response = await (lazy as unknown as (r: Request) => Promise<Response>)(get('/account'));
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(loads).toBe(1);
  });

  it('turns legacy handler results into responses', async () => {
    const wrapped = wrapAppHandler(async (_request: Request): Promise<Response | null> => null, {
      config: {},
      manifest,
      target: 'node',
    });
    const response = (await wrapped(get('/missing'))) as Response;
    expect(response.status).toBe(404);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('request plumbing', () => {
  it('rebuilds Request look-alikes from srvx-style Node servers', async () => {
    class LazyRequest {
      url = 'https://example.com/form';
      method = 'POST';
      headers = new Headers({ 'content-type': 'text/plain' });
      signal = new AbortController().signal;
      redirect: RequestRedirect = 'follow';
      body = new Response('payload').body;
    }
    const lazy = new LazyRequest() as unknown as Request;
    const native = nativeRequest(lazy);
    expect(Object.getPrototypeOf(native)).toBe(Request.prototype);
    expect(await native.text()).toBe('payload');
    expect(native.headers.get('content-type')).toBe('text/plain');
    const real = new Request('https://example.com/');
    expect(nativeRequest(real)).toBe(real);
  });

  it('leaves requests alone outside a HypDriv request', () => {
    const request = new Request('https://example.com/', {
      headers: { 'content-security-policy': "script-src 'nonce-a'" },
    });
    expect(upstreamRequest(request)).toBe(request);
  });
});

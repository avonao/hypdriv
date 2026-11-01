import { ensureContextStore } from '@hypdriv/runtime';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FetchCall {
  method: string;
  path: string;
  clientConn: { ip?: string; country?: string };
  env: string | undefined;
}

const fetched: FetchCall[] = [];
let answer: (request: Request) => Response | null | Promise<Response | null> = () => htmlPage();

const htmlPage = () =>
  new Response('<!DOCTYPE html><html><body><script>boot()</script></body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

// Qwik's own request handler needs the application's router config: the wrapper is tested against a stand-in.
vi.mock('./fetch', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fetch')>();
  return {
    ...original,
    isStaticPath: (method: string, url: URL) => method === 'GET' && url.pathname.startsWith('/build/'),
    createQwikFetch: () => async (request: Request, context: import('./fetch').QwikRequestContext) => {
      fetched.push({
        method: request.method,
        path: new URL(request.url).pathname,
        clientConn: context.clientConn(request),
        env: context.env('GREETING'),
      });
      return answer(request);
    },
  };
});

const { VERCEL_SKEW_COOKIE, withSkewCookie, wrapVercel } = await import('./vercel');

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const wrap = () =>
  wrapVercel({} as never, {
    config: { site: { name: 'qwik-vercel-test' } },
    manifest: null,
    development: false,
  });

beforeAll(async () => {
  await ensureContextStore();
});

beforeEach(() => {
  fetched.length = 0;
  answer = () => htmlPage();
  delete process.env.VERCEL_SKEW_PROTECTION_ENABLED;
});

describe('wrapVercel', () => {
  it('runs the pipeline around Qwik with a nonce policy and gives Qwik the platform’s facts', async () => {
    process.env.GREETING = 'hello';
    const handler = wrap();
    const response = await handler(
      new Request('https://shop.example/dynamic/', {
        headers: { ...BROWSER, 'x-real-ip': '198.51.100.7', 'x-vercel-ip-country': 'US' },
      }),
    );
    delete process.env.GREETING;
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(/'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1]).toBeTruthy();
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ method: 'GET', path: '/dynamic/', env: 'hello' });
    expect(fetched[0]?.clientConn.country).toBe('US');
  });

  it('answers a static path the CDN did not find with 404 and never renders it', async () => {
    const handler = wrap();
    const response = await handler(
      new Request('https://shop.example/build/q-gone.js', { headers: { ...BROWSER, accept: '*/*' } }),
    );
    expect(response.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it('answers 404 when Qwik has no route and 500 when it fails', async () => {
    const handler = wrap();
    answer = () => null;
    expect((await handler(new Request('https://shop.example/nope/', { headers: BROWSER }))).status).toBe(404);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer = () => {
      throw new Error('boom');
    };
    const failed = await handler(new Request('https://shop.example/bad/', { headers: BROWSER }));
    expect(failed.status).toBe(500);
    expect(failed.headers.get('x-error')).toBe('vercel');
    error.mockRestore();
  });

  it('hands Vercel’s waitUntil to the pipeline', async () => {
    const handler = wrap();
    const waiting: Array<Promise<unknown>> = [];
    const response = await handler(new Request('https://shop.example/dynamic/', { headers: BROWSER }), {
      waitUntil: (promise) => void waiting.push(promise),
    });
    expect(response.status).toBe(200);
    await Promise.all(waiting);
  });

  it('sets the skew protection cookie on navigations when Vercel’s skew protection is on', async () => {
    process.env.VERCEL_SKEW_PROTECTION_ENABLED = '1';
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_123';
    const handler = wrap();
    const navigation = await handler(
      new Request('https://shop.example/dynamic/', { headers: { ...BROWSER, 'sec-fetch-dest': 'document' } }),
    );
    delete process.env.VERCEL_DEPLOYMENT_ID;
    expect(navigation.headers.get('set-cookie')).toContain(`${VERCEL_SKEW_COOKIE}=dpl_123`);
  });
});

describe('withSkewCookie', () => {
  const page = () => new Response('x', { headers: { 'content-type': 'text/html' } });
  const request = (headers: Record<string, string> = {}) => new Request('https://shop.example/', { headers });

  it('does nothing without Vercel’s skew protection', () => {
    const response = page();
    expect(withSkewCookie(request({ 'sec-fetch-dest': 'document' }), response, {})).toBe(response);
  });

  it('does nothing for requests that are not browser fetches', () => {
    const response = page();
    expect(withSkewCookie(request(), response, { VERCEL_SKEW_PROTECTION_ENABLED: '1' })).toBe(response);
  });

  it('pins the browser to the deployment, under the base path', () => {
    const out = withSkewCookie(request({ 'sec-fetch-dest': 'document' }), page(), {
      VERCEL_SKEW_PROTECTION_ENABLED: '1',
      VERCEL_DEPLOYMENT_ID: 'dpl 1',
      BASE_URL: '/docs/',
    });
    expect(out.headers.get('set-cookie')).toBe(
      `${VERCEL_SKEW_COOKIE}=dpl%201; Path=/docs/; Secure; SameSite=Strict; HttpOnly`,
    );
  });
});

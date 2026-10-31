import {
  createConsoleLogger,
  createContext,
  emptyManifest,
  getCurrentContext,
  type HypManifest,
  loadConfig,
  routePatternToRegex,
} from '@hypdriv/core';
import { ensureContextStore } from '@hypdriv/runtime';
import { getGlobalStartContext } from '@tanstack/react-start';
import { describe, expect, it, vi } from 'vitest';
import { PRERENDER_HEADER } from './constants';
import {
  createHypDrivMiddleware,
  type HypDrivMiddlewareWithHandler,
  isPrerenderRequest,
  nativeRequest,
  platformInput,
} from './middleware';

const TOKEN = 'a'.repeat(43);
const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const page = (
  id: string,
  pathname: string,
  classification: 'static' | 'dynamic',
): HypManifest['routes'][number] => ({
  id,
  pathname,
  regex: routePatternToRegex(pathname),
  kind: 'page',
  classification,
  runtime: 'nodejs',
  dynamic: false,
  assets: { js: [], css: [], fonts: [] },
});

const manifest = emptyManifest({
  buildId: 'test',
  framework: { name: 'tanstack-start', version: '1.169.4', bundler: 'vite' },
  routes: [page('page:/about', '/about', 'static'), page('page:/request', '/request', 'dynamic')],
  csp: { 'page:/about': { scriptHashes: ["'sha256-prerendered'"], styleHashes: [] } },
});

type ServerFn = (options: {
  request: Request;
  pathname: string;
  context: Record<string, unknown>;
  handlerType: 'serverFn' | 'router';
  next: (options?: { context?: Record<string, unknown> }) => Promise<{ response: Response }>;
}) => Promise<Response | { response: Response }>;

/** Calls the middleware the way TanStack Start's handler does, with `next` rendering `render(context)`. */
async function run(
  middleware: HypDrivMiddlewareWithHandler,
  request: Request,
  render: (context: Record<string, unknown>) => Response | Promise<Response> = (context) =>
    html(`<script>window.$data = 1</script><p>${String(context.nonce ?? '')}</p>`, context.nonce as string),
  context: Record<string, unknown> = {},
) {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const server = (middleware.options as unknown as { server: ServerFn }).server;
  const next = vi.fn(async (options?: { context?: Record<string, unknown> }) => {
    calls.push(options?.context);
    const merged = { ...context, ...options?.context };
    return {
      request,
      pathname: new URL(request.url).pathname,
      context: merged,
      response: await render(merged),
    };
  });
  const result = await server({
    request,
    pathname: new URL(request.url).pathname,
    context,
    handlerType: 'router',
    next,
  });
  const response = result instanceof Response ? result : result.response;
  return { response, next, calls };
}

function html(body: string, nonce?: string) {
  const attr = nonce ? ` nonce="${nonce}"` : '';
  return new Response(
    `<!doctype html><html><head><script${attr}>boot()</script></head><body>${body}</body></html>`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

const middleware = (overrides: Partial<Parameters<typeof createHypDrivMiddleware>[0]> = {}) =>
  createHypDrivMiddleware({
    config: { site: { name: 'tss-test' } },
    manifest,
    prerenderToken: TOKEN,
    target: 'node',
    development: false,
    ...overrides,
  });

describe('createHypDrivMiddleware', () => {
  it('runs the pipeline around Start and hands the request nonce to the router through the context', async () => {
    const { response, calls } = await run(
      middleware(),
      new Request('https://shop.example/request', { headers: BROWSER }),
    );
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(calls).toEqual([{ nonce }]);
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    // Start rendered the nonce itself; the portable injection covers anything it did not (idempotent).
    expect(body).toContain(`<script nonce="${nonce}">boot()</script>`);
    expect(body).toContain(`<script nonce="${nonce}">window.$data = 1</script>`);
    expect(body.match(/nonce=/g)).toHaveLength(2);
  });

  it('installs the Hypdriv context for everything Start runs below it', async () => {
    let seen: { runner?: string; requestId?: string } = {};
    const { response } = await run(
      middleware(),
      new Request('https://shop.example/request', { headers: BROWSER }),
      () => {
        const ctx = getCurrentContext();
        seen = { runner: ctx?.runner, requestId: ctx?.id };
        return html('ok');
      },
    );
    expect(seen.runner).toBe('host');
    expect(seen.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('gives prerendered pages a nonce policy: whatever reaches Start is rendered for this request', async () => {
    const { response } = await run(
      middleware(),
      new Request('https://shop.example/about', { headers: BROWSER }),
    );
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(response.headers.get('content-security-policy')).not.toContain('sha256-prerendered');
  });

  it("leaves Start's own prerender requests alone", async () => {
    const request = new Request('https://localhost/about', {
      headers: { ...BROWSER, [PRERENDER_HEADER]: TOKEN },
    });
    const { response, next, calls } = await run(middleware(), request);
    expect(next).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([undefined]);
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(await response.text()).not.toContain('nonce=');
  });

  it('never honours a wrong, short or emptied token', async () => {
    for (const [token, presented] of [
      [TOKEN, 'b'.repeat(43)],
      ['', ''],
      ['short', 'short'],
    ] as const) {
      const request = new Request('https://shop.example/request', {
        headers: { ...BROWSER, [PRERENDER_HEADER]: presented },
      });
      const { response } = await run(middleware({ prerenderToken: token }), request);
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    }
  });

  it('answers /_hypdriv/* without calling Start', async () => {
    const { response, next } = await run(
      middleware(),
      new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }),
    );
    expect(next).not.toHaveBeenCalled();
    const health = (await response.json()) as { framework: string; runner: string };
    expect(health.framework).toBe('TanStack Start 1.169.4 (Vite)');
    expect(health.runner).toBe('host');
  });

  it('wraps the responses of middleware registered after it (a CSRF rejection gets the posture)', async () => {
    const { response } = await run(
      middleware(),
      new Request('https://shop.example/_serverFn/abc', { method: 'POST', headers: BROWSER }),
      () => new Response('Forbidden', { status: 403 }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('passes through inside an outer Hypdriv runner (Worker shell, server entry) and still forwards its nonce', async () => {
    await ensureContextStore();
    const config = loadConfig({ site: { name: 'outer' } });
    const outer = createContext({
      request: new Request('https://shop.example/request'),
      config,
      manifest,
      env: {},
      runner: 'worker',
      development: false,
      waitUntil: () => undefined,
      ip: '203.0.113.1',
      log: createConsoleLogger({ level: 'error' }),
    });
    outer.requestHeaders.set('x-nonce', 'outer-nonce');
    const store = (await ensureContextStore())!;
    const { response, calls } = await store.run(outer, () =>
      run(middleware(), new Request('https://shop.example/request', { headers: BROWSER }), () =>
        html('inner'),
      ),
    );
    expect(calls).toEqual([{ nonce: 'outer-nonce' }]);
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(await response.text()).toContain('inner');
  });
});

describe('platform input', () => {
  const config = loadConfig({});

  it('reads the socket address and waitUntil srvx puts on the request', () => {
    const request = Object.assign(new Request('https://shop.example/'), {
      ip: '198.51.100.7',
      waitUntil: vi.fn(),
    });
    const input = platformInput(request, {}, config);
    expect(input.ip).toBe('198.51.100.7');
    const promise = Promise.resolve();
    input.waitUntil?.(promise);
    expect(request.waitUntil).toHaveBeenCalledWith(promise);
  });

  it('lets forwarded headers decide behind trusted proxies', () => {
    const request = Object.assign(new Request('https://shop.example/'), { ip: '10.0.0.2' });
    expect(platformInput(request, {}, loadConfig({ security: { trustedProxies: 1 } })).ip).toBeUndefined();
  });

  it("takes Workers' env and ctx from the Start context", () => {
    const ctx = { waitUntil: vi.fn() };
    const env = { HYPDRIV_LIMITER: {} };
    const input = platformInput(new Request('https://shop.example/'), { cloudflare: { env, ctx } }, config);
    expect(input.env).toBe(env);
    const promise = Promise.resolve();
    input.waitUntil?.(promise);
    expect(ctx.waitUntil).toHaveBeenCalledWith(promise);
  });

  it("unwraps srvx's lazy request to the native one", () => {
    const inner = new Request('https://shop.example/x', { method: 'POST', body: 'hi' });
    const outer = Object.assign(new Request('https://shop.example/x'), { _request: inner });
    expect(nativeRequest(outer)).toBe(inner);
    const plain = new Request('https://shop.example/y');
    expect(nativeRequest(plain)).toBe(plain);
  });

  it('detects prerender requests with a constant-time comparison of the full token', () => {
    const at = (value: string) => new Request('https://x/', { headers: { [PRERENDER_HEADER]: value } });
    expect(isPrerenderRequest(at(TOKEN), TOKEN)).toBe(true);
    expect(isPrerenderRequest(at(`${TOKEN}x`), TOKEN)).toBe(false);
    expect(isPrerenderRequest(new Request('https://x/'), TOKEN)).toBe(false);
    expect(isPrerenderRequest(at(''), '')).toBe(false);
  });
});

describe('hypdrivSsr', () => {
  it('reads the nonce from the Start context on the server and nothing outside a request', async () => {
    const { hypdrivSsr } = await import('./ssr');
    expect(hypdrivSsr()).toBeUndefined();
    const storage = (globalThis as Record<symbol, { run<T>(store: unknown, fn: () => T): T } | undefined>)[
      Symbol.for('tanstack-start:start-storage-context')
    ];
    expect(storage).toBeDefined();
    expect(typeof getGlobalStartContext).toBe('function');
    expect(storage!.run({ contextAfterGlobalMiddlewares: { nonce: 'n0nce' } }, () => hypdrivSsr())).toEqual({
      nonce: 'n0nce',
    });
    expect(storage!.run({ contextAfterGlobalMiddlewares: {} }, () => hypdrivSsr())).toBeUndefined();
  });
});

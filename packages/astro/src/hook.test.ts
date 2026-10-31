import { createContext, type HypDrivConfig, loadConfig, runWithContext } from '@hypdriv/core';
import { ensureContextStore, type HypRequestContext, hyp } from '@hypdriv/runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  type AstroContextLike,
  type AstroNext,
  createAstroHandler,
  createOnRequest,
  forwardTo,
  platformInput,
} from './hook';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US', ...headers },
  });
}

function context(req: Request, extra: Partial<AstroContextLike> = {}): AstroContextLike {
  return {
    request: req,
    isPrerendered: false,
    locals: {},
    get clientAddress() {
      return '203.0.113.9';
    },
    ...extra,
  };
}

const page = (
  body = '<!doctype html><html><head><script>go()</script></head><body>hi</body></html>',
  status = 200,
) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

function setup(config: HypDrivConfig = {}, flags: { prerendering?: boolean; development?: boolean } = {}) {
  const handler = createAstroHandler({
    config: { site: { name: 'astro-test' }, ...config },
    manifest: null,
    development: flags.development ?? false,
    target: 'node',
  });
  return createOnRequest({
    handler,
    prerendering: flags.prerendering ?? false,
    development: flags.development ?? false,
  });
}

describe('createOnRequest', () => {
  it('runs the pipeline around next(): headers, nonce injection and hyp() inside the render', async () => {
    const onRequest = setup();
    let seen: HypRequestContext | null = null;
    const res = await onRequest(context(request('/ssr')), async () => {
      seen = hyp();
      return page();
    });
    expect(seen).not.toBeNull();
    const ctx = seen as unknown as HypRequestContext;
    expect(ctx.runner).toBe('host');
    expect(res.headers.get('x-request-id')).toBe(ctx.requestId);
    expect(res.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(res.headers.get('content-security-policy')).toContain(`'nonce-${ctx.nonce}'`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.text()).toContain(`<script nonce="${ctx.nonce}">go()</script>`);
  });

  it('passes build-time prerendering through untouched', async () => {
    const original = page();
    const next = vi.fn<AstroNext>(async () => original);
    expect(await setup({}, { prerendering: true })(context(request('/')), next)).toBe(original);
    expect(await setup()(context(request('/about'), { isPrerendered: true }), next)).toBe(original);
    expect(next).toHaveBeenCalledTimes(2);
    expect(original.headers.get('x-request-id')).toBeNull();
  });

  it('runs for prerendered routes in development, where they render per request', async () => {
    const res = await setup({}, { development: true })(
      context(request('/about'), { isPrerendered: true }),
      async () => page(),
    );
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('passes through inside an outer Hypdriv runner (the Cloudflare Worker shell, src/fetch.ts)', async () => {
    await ensureContextStore();
    const onRequest = setup();
    const req = request('/ssr');
    const outer = createContext({ request: req, config: loadConfig({}), runner: 'worker' });
    const original = page();
    const res = await runWithContext(outer, () => onRequest(context(req), async () => original));
    expect(res).toBe(original);
  });

  it("answers Hypdriv's internal routes without rendering", async () => {
    const next = vi.fn<AstroNext>(async () => page());
    const res = await setup()(context(request('/_hypdriv/health')), next);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runner: 'host', target: 'node' });
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks definite automation on documents before rendering', async () => {
    const next = vi.fn<AstroNext>(async () => page());
    const res = await setup({ security: { bots: { definitelyAutomated: 'block' } } })(
      context(request('/ssr', { 'user-agent': 'curl/8.9.1' })),
      next,
    );
    expect(res.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves a policy the application set (Astro security.csp) in place', async () => {
    const res = await setup()(context(request('/ssr')), async () => {
      const res = page();
      res.headers.set('content-security-policy', "script-src 'self' 'sha256-abc'");
      return res;
    });
    expect(res.headers.get('content-security-policy')).toBe("script-src 'self' 'sha256-abc'");
    expect(res.headers.get('x-hypdriv-csp')).toBe('app');
    expect(await res.text()).not.toContain('nonce=');
  });

  it("finishes Astro's 500 page after a render error without counting the request twice", async () => {
    const onRequest = setup({
      security: { rateLimit: [{ id: 'all', match: '/**', limit: 1, window: '1m', key: ['ip'] }] },
    });
    const ctx = context(request('/broken'));
    await expect(
      onRequest(ctx, async () => {
        throw new Error('render failed');
      }),
    ).rejects.toThrow('render failed');
    // Astro renders 500.astro through the middleware again, for the same Request.
    let seen: HypRequestContext | null = null;
    const errorPage = await onRequest(ctx, async () => {
      seen = hyp();
      return page('<html><body><script>report()</script></body></html>', 500);
    });
    const pass = seen as unknown as HypRequestContext;
    expect(errorPage.status).toBe(500);
    expect(errorPage.headers.get('x-request-id')).toBe(pass.requestId);
    expect(errorPage.headers.get('content-security-policy')).toContain(`'nonce-${pass.nonce}'`);
    expect(await errorPage.text()).toContain(`nonce="${pass.nonce}"`);
    // The first pass counted the request once: the client's next request is over the limit of 1.
    const after = await onRequest(context(request('/other')), async () => page());
    expect(after.status).toBe(429);
  });

  it("drops the empty error response's policy when Astro renders the error page for it", async () => {
    const onRequest = setup({
      security: { rateLimit: [{ id: 'all', match: '/**', limit: 1, window: '1m', key: ['ip'] }] },
    });
    const ctx = context(request('/missing'));
    const empty = await onRequest(
      ctx,
      async () => new Response(null, { status: 404, headers: { 'content-type': 'text/html' } }),
    );
    expect(empty.headers.get('content-security-policy')).toBeTruthy();
    const errorPage = await onRequest(ctx, async () => page('<html><body>Not found</body></html>', 404));
    expect(errorPage.status).toBe(404);
    expect(errorPage.headers.get('x-hypdriv-csp')).toBe('nonce');
    // Astro merges the first response's headers over the error page's; the stale policy is gone.
    expect(empty.headers.get('content-security-policy')).toBeNull();
    expect(empty.headers.get('x-hypdriv-csp')).toBeNull();
  });
});

describe('platformInput', () => {
  it("hands Cloudflare's waitUntil, request.cf and Astro's client address to the handler", () => {
    const waitUntil = vi.fn();
    const cfContext = { waitUntil };
    const req = request('/');
    Object.defineProperty(req, 'cf', { value: { country: 'US', colo: 'IAD' } });
    const input = platformInput(context(req, { locals: { cfContext } }));
    const promise = Promise.resolve();
    input.waitUntil?.(promise);
    expect(waitUntil).toHaveBeenCalledWith(promise);
    expect(input.cf).toEqual({ country: 'US', colo: 'IAD' });
    expect(input.ip).toBe('203.0.113.9');
  });

  it('omits what the adapter does not provide', () => {
    const input = platformInput({
      request: request('/'),
      isPrerendered: false,
      locals: {},
      get clientAddress(): string {
        throw new Error('clientAddress is not available');
      },
    });
    expect(input).toEqual({});
  });
});

describe('forwardTo', () => {
  it('renders the route, or rewrites when a stage changed the target', async () => {
    const next = vi.fn<AstroNext>(async () => page());
    const original = request('/a?x=1');
    await forwardTo(next, original, new Request(original, { headers: { 'x-extra': '1' } }));
    expect(next).toHaveBeenLastCalledWith();
    await forwardTo(next, original, new Request('http://localhost/de/a?x=1'));
    expect(next).toHaveBeenLastCalledWith('/de/a?x=1');
  });
});

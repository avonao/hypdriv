import { describe, expect, it, vi } from 'vitest';
import * as browser from './client';
import { hypdrivMiddleware, hypdrivRequestMiddleware, renderedManifest } from './index';
import * as browserHelpers from './server-client';

type ServerFn = (options: {
  request: Request;
  pathname: string;
  context: Record<string, unknown>;
  handlerType: 'serverFn' | 'router';
  next: () => Promise<{ response: Response }>;
}) => Promise<Response | { response: Response }>;

const serverOf = (middleware: unknown) => (middleware as { options: { server: ServerFn } }).options.server;

async function call(middleware: unknown, request: Request, handlerType: 'serverFn' | 'router') {
  const next = vi.fn(async () => ({
    request,
    pathname: new URL(request.url).pathname,
    context: {},
    response: new Response('ok'),
  }));
  const result = await serverOf(middleware)({
    request,
    pathname: new URL(request.url).pathname,
    context: {},
    handlerType,
    next,
  });
  return { response: result instanceof Response ? result : result.response, next };
}

describe('default entry', () => {
  it('shares one middleware instance: Start evaluates the createStart() callback per request', () => {
    expect(hypdrivMiddleware()).toBe(hypdrivMiddleware());
    expect(hypdrivRequestMiddleware()).toBe(hypdrivRequestMiddleware());
    expect(hypdrivRequestMiddleware()[0]).toBe(hypdrivMiddleware());
    expect(hypdrivMiddleware({ development: false })).not.toBe(hypdrivMiddleware());
  });

  it('uses the build config and manifest (virtual modules) by default', async () => {
    const health = await call(
      hypdrivMiddleware(),
      new Request('https://shop.example/_hypdriv/health'),
      'router',
    );
    const body = (await health.response.json()) as { service: string; routes: number; framework: string };
    expect(body.service).toBe('fixture');
    expect(body.routes).toBe(2);
    expect(body.framework).toContain('TanStack Start');
  });

  it("puts Start's CSRF protection for server functions after HypDriv", async () => {
    const [, csrf] = hypdrivRequestMiddleware();
    const crossSite = new Request('https://shop.example/_serverFn/abc', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    const rejected = await call(csrf, crossSite, 'serverFn');
    expect(rejected.response.status).toBe(403);
    expect(rejected.next).not.toHaveBeenCalled();
    const sameOrigin = await call(
      csrf,
      new Request('https://shop.example/_serverFn/abc', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      'serverFn',
    );
    expect(sameOrigin.next).toHaveBeenCalled();
    // Page navigations from other sites are not server-function calls.
    const page = await call(
      csrf,
      new Request('https://shop.example/', { headers: { 'sec-fetch-site': 'cross-site' } }),
      'router',
    );
    expect(page.next).toHaveBeenCalled();
  });

  it('can leave CSRF to the application or adjust it', async () => {
    expect(hypdrivRequestMiddleware({ csrf: false })).toHaveLength(1);
    const [, csrf] = hypdrivRequestMiddleware({ csrf: { secFetchSite: ['same-origin', 'same-site'] } });
    const sameSite = await call(
      csrf,
      new Request('https://shop.example/_serverFn/abc', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-site' },
      }),
      'serverFn',
    );
    expect(sameSite.next).toHaveBeenCalled();
  });

  it('exports the manifest view for custom runners', () => {
    expect(typeof renderedManifest).toBe('function');
  });
});

describe('browser builds', () => {
  it('keep the request middleware inert and report no request', async () => {
    const [hypdriv, csrf] = browser.hypdrivRequestMiddleware();
    expect(hypdriv).toBe(browser.hypdrivMiddleware());
    expect(csrf).not.toBe(hypdriv);
    const { next } = await call(hypdriv, new Request('https://shop.example/x'), 'router');
    expect(next).toHaveBeenCalled();
    expect(browser.hypdrivSsr()).toBeUndefined();
    expect(browser.isPrerenderRequest(new Request('https://x/'), 'x'.repeat(40))).toBe(false);
  });

  it('give the request helpers their outside-a-request answers', async () => {
    expect(browserHelpers.hyp()).toBeNull();
    expect(() => browserHelpers.requireHyp()).toThrow(/server function/);
    expect(browserHelpers.nonce()).toBeUndefined();
    expect(browserHelpers.flag('newHero', true)).toBe(true);
    expect(browserHelpers.flag('newHero')).toBeUndefined();
    expect(browserHelpers.geo()).toEqual({});
    const task = vi.fn(async () => undefined);
    browserHelpers.defer(task);
    expect(task).toHaveBeenCalled();
    await expect(browserHelpers.jobHandler({}, async () => null)(new Request('https://x/'))).rejects.toThrow(
      /server only/,
    );
  });
});

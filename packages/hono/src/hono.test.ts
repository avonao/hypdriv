import { routeId } from '@hypdriv/core';
import { ensureContextStore } from '@hypdriv/runtime';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { wrapHono } from './app';
import {
  type HypDrivHonoOptions,
  type HypDrivHonoVariables,
  hyp,
  hypdriv,
  nonce,
  platformInput,
  useHypDriv,
} from './index';
import { honoManifest, honoPattern } from './manifest';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const options = (overrides: Partial<HypDrivHonoOptions> = {}): HypDrivHonoOptions => ({
  config: { site: { name: 'hono-test' } },
  target: 'node',
  development: false,
  ...overrides,
});

type Env = { Variables: HypDrivHonoVariables };

/** An app whose page renders the request's nonce on its own script tag, with a few more routes. */
function routes(app: Hono<Env>) {
  app.get('/', (c) =>
    c.html(
      `<!doctype html><html><head><script nonce="${nonce() ?? ''}">boot()</script></head><body><p>${c.get('hypdrivNonce') ?? ''}</p><script>late()</script></body></html>`,
    ),
  );
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id'), route: hyp()?.route ?? null }));
  app.get('/api/time', (c) => c.json({ ok: true }));
  app.get('/facts', (c) => {
    const ctx = hyp();
    return c.json({
      runner: ctx?.runner ?? null,
      requestId: ctx?.requestId ?? null,
      binding: (ctx?.env as Record<string, unknown> | undefined)?.GREETING ?? null,
    });
  });
  app.get('/defer', (c) => {
    hyp()?.waitUntil(Promise.resolve('background'));
    return c.text('ok');
  });
  app.get('/own-headers', (c) => c.text('ok', 200, { 'x-powered-by': 'app', 'x-app': 'yes' }));
  return app;
}

const withMiddleware = (opts: HypDrivHonoOptions = options()) => {
  const app = new Hono<Env>();
  const middleware = hypdriv(opts);
  app.use(middleware);
  return { app: routes(app), middleware };
};

const withWrapper = (opts: HypDrivHonoOptions = options()) => {
  const app = routes(new Hono<Env>());
  return { app, wrapped: wrapHono(app, opts) };
};

beforeAll(async () => {
  await ensureContextStore();
});

describe('hypdriv() middleware', () => {
  it('runs the pipeline around the app and hands the request nonce to the page', async () => {
    const { app } = withMiddleware();
    const response = await app.request('https://shop.example/', { headers: BROWSER });
    const csp = response.headers.get('content-security-policy') ?? '';
    const found = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(found).toBeTruthy();
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain(`<script nonce="${found}">boot()</script>`);
    expect(body).toContain(`<p>${found}</p>`);
    // The tag the app did not mark gets the nonce from the portable injection.
    expect(body).toContain(`<script nonce="${found}">late()</script>`);
  });

  it('answers not-found responses and errors through the pipeline too', async () => {
    const { app } = withMiddleware();
    const missing = await app.request('https://shop.example/nothing-here', { headers: BROWSER });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    expect(missing.headers.get('x-request-id')).toBeTruthy();
  });

  it('lets the pipeline remove a header the app set: Context#res must not merge the old ones back', async () => {
    const { app } = withMiddleware();
    const response = await app.request('https://shop.example/own-headers', { headers: BROWSER });
    // The pipeline strips `x-powered-by`; a plain `c.res = response` would put the app's copy back.
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-app')).toBe('yes');
    const wrapped = await withWrapper().wrapped.fetch(
      new Request('https://shop.example/own-headers', { headers: BROWSER }),
      {},
    );
    expect(wrapped.headers.get('x-powered-by')).toBeNull();
  });

  it('serves the internal routes and reports the host', async () => {
    const { app } = withMiddleware();
    const response = await app.request('https://shop.example/_hypdriv/health', { headers: BROWSER });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('hono');
  });

  it('rate-limits without calling the app, keyed by the socket address on Node', async () => {
    const { app } = withMiddleware(
      options({
        config: {
          site: { name: 'hono-test' },
          security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 2, window: '1m', key: ['ip'] }] },
        },
      }),
    );
    const node = (address: string) => ({ incoming: { socket: { remoteAddress: address } }, outgoing: {} });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.request('https://shop.example/api/time', { headers: BROWSER }, node('203.0.113.9'));
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const other = await app.request(
      'https://shop.example/api/time',
      { headers: BROWSER },
      node('203.0.113.10'),
    );
    expect(other.status).toBe(200);
  });

  it('exposes the request context below it: runner, id and the Cloudflare bindings', async () => {
    const { app } = withMiddleware();
    const response = await app.request(
      'https://shop.example/facts',
      { headers: BROWSER },
      { GREETING: 'hi' },
    );
    const body = (await response.json()) as { runner: string; requestId: string; binding: string };
    expect(body.runner).toBe('host');
    expect(body.requestId).toBe(response.headers.get('x-request-id'));
    expect(body.binding).toBe('hi');
  });

  it('hands background work to the platform’s ctx.waitUntil', async () => {
    const waitUntil = vi.fn();
    const { app } = withMiddleware();
    const response = await app.request('https://shop.example/defer', { headers: BROWSER }, {}, {
      waitUntil,
      passThroughOnException() {},
    } as never);
    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalled();
  });
});

describe('useHypDriv()', () => {
  it('registers the middleware and gives the pipeline the routes the app registered after it', async () => {
    const app = new Hono<Env>();
    useHypDriv(app, options());
    routes(app);
    const response = await app.request('https://shop.example/users/42', { headers: BROWSER });
    const body = (await response.json()) as { id: string; route: string };
    expect(body.id).toBe('42');
    expect(body.route).toBe(routeId('endpoint', '/users/[id]'));
  });
});

describe('wrapHono()', () => {
  it('has the app’s fetch signature and runs the pipeline around it', async () => {
    const { wrapped } = withWrapper();
    const response = await wrapped.fetch(new Request('https://shop.example/', { headers: BROWSER }), {});
    const csp = response.headers.get('content-security-policy') ?? '';
    const found = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(found).toBeTruthy();
    const body = await response.text();
    expect(body).toContain(`<script nonce="${found}">boot()</script>`);
    expect(body).toContain(`<script nonce="${found}">late()</script>`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('passes Workers bindings and waitUntil through and derives the manifest from the app', async () => {
    const { wrapped } = withWrapper();
    const waitUntil = vi.fn();
    const facts = await wrapped.fetch(
      new Request('https://shop.example/facts', { headers: BROWSER }),
      { GREETING: 'moin' },
      {
        waitUntil,
      },
    );
    expect(((await facts.json()) as { binding: string }).binding).toBe('moin');
    const user = await wrapped.fetch(new Request('https://shop.example/users/7', { headers: BROWSER }), {});
    expect(((await user.json()) as { route: string }).route).toBe(routeId('endpoint', '/users/[id]'));
  });

  it('answers the same as the middleware for the pipeline-managed headers', async () => {
    const viaMiddleware = await withMiddleware().app.request('https://shop.example/api/time', {
      headers: BROWSER,
    });
    const viaWrapper = await withWrapper().wrapped.fetch(
      new Request('https://shop.example/api/time', { headers: BROWSER }),
      {},
    );
    for (const name of [
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'permissions-policy',
    ]) {
      expect(viaWrapper.headers.get(name)).toBe(viaMiddleware.headers.get(name));
    }
    expect(viaWrapper.status).toBe(viaMiddleware.status);
  });
});

describe('platformInput()', () => {
  const config = withMiddleware().middleware.handler.config;
  const request = new Request('https://shop.example/');

  it('takes bindings as the environment and the socket address from Node bindings, never both', () => {
    expect(platformInput(request, { KV: 1 }, undefined, config).env).toEqual({ KV: 1 });
    const node = platformInput(
      request,
      { incoming: { socket: { remoteAddress: '198.51.100.7' } }, outgoing: {} },
      undefined,
      config,
    );
    expect(node.ip).toBe('198.51.100.7');
    expect(node.env).toBeUndefined();
  });

  it('ignores the socket address when the server sits behind proxies', () => {
    const behind = withMiddleware(
      options({ config: { site: { name: 'x' }, security: { trustedProxies: 1 } } }),
    ).middleware.handler.config;
    const node = platformInput(
      request,
      { incoming: { socket: { remoteAddress: '10.0.0.1' } }, outgoing: {} },
      undefined,
      behind,
    );
    expect(node.ip).toBeUndefined();
  });
});

describe('honoPattern()', () => {
  it.each([
    ['GET', '/', '/'],
    ['GET', '/users/:id', '/users/[id]'],
    ['GET', '/posts/:id{[0-9]+}', '/posts/[id]'],
    ['GET', '/:lang?/about', '/[[lang]]/about'],
    ['GET', '/files/*', '/files/[...splat]'],
    ['GET', '/a/*/b', '/a/[splat]/b'],
    ['POST', '/api/items', '/api/items'],
    ['ALL', '/health', '/health'],
    ['GET', '*', '/[...splat]'],
  ])('%s %s → %s', (method, path, expected) => {
    expect(honoPattern(method, path)).toBe(expected);
  });

  it.each([
    ['ALL', '*'],
    ['ALL', '/*'],
    ['ALL', '/api/*'],
  ])('treats %s %s as middleware', (method, path) => {
    expect(honoPattern(method, path)).toBeNull();
  });
});

describe('honoManifest()', () => {
  it('lists one dynamic endpoint per path, skipping middleware', () => {
    const app = new Hono();
    app.use('*', async (_c, next) => next());
    app.use('/api/*', async (_c, next) => next());
    app.get('/users/:id', (c) => c.text('u'));
    app.post('/users/:id', (c) => c.text('u'));
    app.get('/', (c) => c.text('home'));
    const manifest = honoManifest(app, { version: '4.13.16' });
    expect(manifest.routes.map((r) => r.pathname)).toEqual(['/users/[id]', '/']);
    expect(manifest.framework).toEqual({ name: 'hono', version: '4.13.16' });
    expect(manifest.routes.every((r) => r.classification === 'route' && r.kind === 'endpoint')).toBe(true);
    expect(manifest.routes[0]?.dynamic).toBe(true);
    expect(manifest.routes[1]?.dynamic).toBe(false);
    expect(new RegExp(manifest.routes[0]?.regex ?? '').test('/users/42')).toBe(true);
  });
});

import { emptyManifest, type HypManifest, routePatternToRegex } from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { createProxy, matcher } from './index';

const manifest: HypManifest = emptyManifest({
  buildId: 'b1',
  routes: [
    {
      id: 'app:/',
      pathname: '/',
      regex: routePatternToRegex('/'),
      kind: 'app-page',
      classification: 'static',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: ['/_next/static/chunks/main.js'], css: ['/_next/static/css/app.css'], fonts: [] },
    },
    {
      id: 'app:/account',
      pathname: '/account',
      regex: routePatternToRegex('/account'),
      kind: 'app-page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
    {
      id: 'route:/api/items',
      pathname: '/api/items',
      regex: routePatternToRegex('/api/items'),
      kind: 'app-route',
      classification: 'route',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
});

/** What `NextResponse.next({ request: { headers } })` produces: a marker response carrying the overridden headers. */
function markerNext() {
  const seen: Request[] = [];
  const next = vi.fn(async (request: Request) => {
    seen.push(request);
    const headers = new Headers({ 'x-middleware-next': '1' });
    const keys: string[] = [];
    for (const [k, v] of request.headers) {
      headers.set(`x-middleware-request-${k}`, v);
      keys.push(k);
    }
    headers.set('x-middleware-override-headers', keys.join(','));
    return new Response(null, { headers });
  });
  return { next, seen };
}

const event = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p: Promise<unknown>) => pending.push(p) };
};

describe('createProxy', () => {
  it('runs the stages and forwards HypDriv headers to the application', async () => {
    const { next, seen } = markerNext();
    const proxy = createProxy({ site: { name: 'shop' } }, undefined, { manifest, env: {}, next });
    const response = await proxy(
      new Request('https://shop.example.com/', {
        headers: {
          'cf-ipcountry': 'US',
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        },
      }),
      event(),
    );
    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = seen[0]!.headers;
    expect(forwarded.get('x-hypdriv-runner')).toBe('proxy');
    expect(forwarded.get('x-hypdriv-route')).toBe('app:/');
    expect(forwarded.get('x-hypdriv-pathname')).toBe('/');
    expect(forwarded.get('x-hypdriv-request-id')).toBeTruthy();
    expect(forwarded.get('x-hypdriv-country')).toBe('US');
    // Response headers from post stages are applied on the pass-through response.
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-hypdriv-request-id')).toBe(forwarded.get('x-hypdriv-request-id'));
    expect(response.headers.get('server-timing')).toBeTruthy();
  });

  it('short-circuits with the maintenance page and lets health checks through', async () => {
    const { next } = markerNext();
    const proxy = createProxy({ maintenance: { enabled: true, bypassPaths: ['/api/health'] } }, undefined, {
      manifest,
      env: {},
      next,
    });
    const blocked = await proxy(
      new Request('https://shop.example.com/account', { headers: { accept: 'text/html' } }),
      event(),
    );
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.text()).toContain('<html');
    expect(next).not.toHaveBeenCalled();
  });

  it('answers configured redirects before rendering', async () => {
    const { next } = markerNext();
    const proxy = createProxy(
      { redirects: { rules: [{ from: '/old/:slug', to: '/new/:slug', status: 308 }] } },
      undefined,
      { manifest, env: {}, next },
    );
    const response = await proxy(new Request('https://shop.example.com/old/shoes?ref=x'), event());
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://shop.example.com/new/shoes?ref=x');
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a custom stage list and keeps going when a stage throws', async () => {
    const { next } = markerNext();
    const proxy = createProxy(
      {},
      (defaults) => [
        ...defaults,
        {
          name: 'broken',
          pre() {
            throw new Error('stage bug');
          },
        },
      ],
      { manifest, env: {}, next },
    );
    const response = await proxy(new Request('https://shop.example.com/api/items'), event());
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('initialises the platform once', async () => {
    const { next } = markerNext();
    const factory = vi.fn(
      (defaults: Parameters<Exclude<Parameters<typeof createProxy>[1], undefined | unknown[]>>[0]) =>
        defaults,
    );
    const proxy = createProxy({}, factory as never, { manifest, env: {}, next });
    await proxy(new Request('https://shop.example.com/'), event());
    await proxy(new Request('https://shop.example.com/account'), event());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('propagates upstream failures when nothing can be recovered', async () => {
    const proxy = createProxy({}, undefined, {
      manifest,
      env: {},
      next: async () => {
        throw new Error('upstream down');
      },
    });
    await expect(proxy(new Request('https://shop.example.com/account'), event())).rejects.toThrow(
      'upstream down',
    );
  });
});

describe('matcher', () => {
  it('skips Next internals and static files but keeps internal HypDriv routes', () => {
    const [main, internal] = matcher.matcher;
    const re = new RegExp(`^${main!.replace('/(', '/(').replace(/\(\?!/, '(?!')}$`);
    expect(re.test('/pricing')).toBe(true);
    expect(re.test('/_next/static/chunks/a.js')).toBe(false);
    expect(re.test('/logo.svg')).toBe(false);
    expect(internal).toBe('/_hypdriv/:path*');
  });
});

describe('createProxy hardening', () => {
  it('drops client-supplied HypDriv headers before the stages run', async () => {
    const { next, seen } = markerNext();
    const proxy = createProxy({}, undefined, { manifest, env: {}, next });
    await proxy(
      new Request('https://shop.example.com/api/items', {
        headers: { 'x-hypdriv-flags': '{"admin":true}', 'x-hypdriv-route': 'forged', 'x-nonce': 'attacker' },
      }),
      event(),
    );
    const forwarded = seen[0]!.headers;
    expect(forwarded.get('x-hypdriv-route')).toBe('route:/api/items');
    expect(forwarded.get('x-nonce')).not.toBe('attacker');
    expect(forwarded.get('x-hypdriv-flags')).toBeNull();
  });

  it('passes through untouched inside the HypDriv Worker', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const { createContext, loadConfig, setContextStore, runWithContext } = await import('@hypdriv/core');
    const als = new AsyncLocalStorage<ReturnType<typeof createContext>>();
    setContextStore({ getStore: () => als.getStore(), run: (c, fn) => als.run(c, fn) });
    try {
      const { next } = markerNext();
      const proxy = createProxy({ maintenance: { enabled: true } }, undefined, { manifest, env: {}, next });
      const workerCtx = createContext({
        request: new Request('https://shop.example.com/account'),
        config: loadConfig({}),
        runner: 'worker',
      });
      const response = await runWithContext(workerCtx, () =>
        proxy(new Request('https://shop.example.com/account'), event()),
      );
      expect(response.status).toBe(200);
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      setContextStore(null);
    }
  });
});

describe('internal routes on the proxy runner', () => {
  it('answers /_hypdriv/health and keeps dev endpoints closed in production', async () => {
    const { next } = markerNext();
    const proxy = createProxy({ site: { name: 'shop' } }, undefined, {
      manifest,
      env: {},
      next,
      development: false,
    });
    const health = await proxy(new Request('https://shop.example.com/_hypdriv/health'), event());
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'shop', build: 'b1', routes: 3 });
    const dev = await proxy(new Request('https://shop.example.com/_hypdriv/dev/state'), event());
    expect(dev.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('serves dev state with the proxy runner in development', async () => {
    const { next } = markerNext();
    const proxy = createProxy({}, undefined, {
      manifest,
      env: {},
      next,
      development: true,
      devState: async () => ({ purser: { ok: true } }),
    });
    const res = await proxy(new Request('https://shop.example.com/_hypdriv/dev/state'), event());
    expect(await res.json()).toMatchObject({ runner: 'proxy', purser: { ok: true } });
  });
});

describe('createProxy on Vercel', () => {
  const config = {
    site: { name: 'shop' },
    cache: {
      edge: {
        policies: [{ id: 'items', match: '/api/items', ttl: '2m', respectOrigin: false, tags: ['items'] }],
      },
    },
  };

  it('replaces the edge cache with Vercel CDN headers and registers the Vercel purger', async () => {
    const { getEdgePurger } = await import('@hypdriv/cache');
    const { next } = markerNext();
    const names: string[] = [];
    const proxy = createProxy(
      config,
      (defaults) => {
        names.push(...defaults.map((s) => s.name));
        return defaults;
      },
      { manifest, env: { VERCEL: '1', VERCEL_ENV: 'production' }, next },
    );
    const response = await proxy(
      new Request('https://shop.example.com/api/items', {
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15',
        },
      }),
      event(),
    );
    expect(names).toContain('edge-cache');
    expect(names).not.toContain('html-transforms');
    expect(response.headers.get('vercel-cdn-cache-control')).toMatch(/s-maxage=120/);
    expect(response.headers.get('vercel-cache-tag')).toContain('items');
    expect(response.headers.get('x-hypdriv-cache')).toBe('CDN');
    const purger = getEdgePurger();
    expect(purger).toBeDefined();
    expect(typeof purger!.purgeTags).toBe('function');
  });

  it('keeps the Cloudflare/Node wiring when the target is not Vercel', async () => {
    const { next } = markerNext();
    const names: string[] = [];
    const proxy = createProxy(
      config,
      (defaults) => {
        names.push(...defaults.map((s) => s.name));
        return defaults;
      },
      { manifest, env: {}, next, target: 'node' },
    );
    const response = await proxy(new Request('https://shop.example.com/api/items'), event());
    expect(names).toContain('edge-cache');
    expect(response.headers.get('x-hypdriv-cache')).toBe('MISS');
    expect(response.headers.get('vercel-cdn-cache-control')).toBeNull();
  });
});

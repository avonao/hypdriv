import { ensureContextStore } from '@hypdriv/runtime';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FetchCall {
  method: string;
  path: string;
  clientConn: { ip?: string; country?: string };
  env: string | undefined;
}

const fetched: FetchCall[] = [];
let answer: (request: Request) => Response | null | Promise<Response | null> = () =>
  new Response('<!DOCTYPE html><html><body><script>boot()</script></body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

// Qwik's own request handler needs the application's router config: the wrapper is tested against a stand-in.
vi.mock('./fetch', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fetch')>();
  return {
    ...original,
    isStaticPath: (method: string, url: URL) =>
      method === 'GET' && (url.pathname.startsWith('/build/') || url.pathname === '/about/'),
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

const { bothHandlers, isSharedCacheable, wrapCloudflare } = await import('./cloudflare');

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const options = (extra: Record<string, unknown> = {}) => ({
  config: {
    site: { name: 'qwik-worker-test' },
    jobs: {
      cron: { nightly: { cron: '0 3 * * *', path: '/api/jobs/nightly' } },
      queues: { mail: { path: '/api/jobs/mail' } },
    },
  },
  manifest: null,
  development: false,
  ...extra,
});

const exec = () => {
  const waiting: Array<Promise<unknown>> = [];
  return { waitUntil: (p: Promise<unknown>) => void waiting.push(p), waiting };
};

const assets = (log: string[], files: Record<string, string>) => ({
  fetch: async (request: Request) => {
    const { pathname } = new URL(request.url);
    log.push(`${request.method} ${pathname}`);
    const body = files[pathname];
    return body === undefined
      ? new Response('Not Found', { status: 404 })
      : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

type Worker = {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  scheduled(event: unknown, env: unknown, ctx: unknown): Promise<void>;
  queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
  email(message: unknown, env: unknown, ctx: unknown): Promise<void>;
  tail(events: unknown[], env: unknown, ctx: unknown): Promise<void>;
};

beforeAll(async () => {
  await ensureContextStore();
});

beforeEach(() => {
  fetched.length = 0;
  answer = () =>
    new Response('<!DOCTYPE html><html><body><script>boot()</script></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
});

describe('isSharedCacheable', () => {
  const response = (headers: Record<string, string>) => new Response('x', { headers });
  it('follows Qwik’s rule: Cache-Control present, no cookie, nothing private', () => {
    expect(isSharedCacheable(response({ 'cache-control': 'public, max-age=60' }))).toBe(true);
    expect(isSharedCacheable(response({ 'cache-control': 's-maxage=60, stale-while-revalidate=30' }))).toBe(
      true,
    );
    expect(isSharedCacheable(response({}))).toBe(false);
    expect(isSharedCacheable(response({ 'cache-control': 'private, max-age=60' }))).toBe(false);
    expect(isSharedCacheable(response({ 'cache-control': 'no-store' }))).toBe(false);
    expect(isSharedCacheable(response({ 'cache-control': 'max-age=0, No-Cache' }))).toBe(false);
    expect(isSharedCacheable(response({ 'cache-control': 'public, max-age=60', 'set-cookie': 'a=1' }))).toBe(
      false,
    );
  });
});

describe('bothHandlers', () => {
  it('returns Hypdriv’s handler when the application has none', () => {
    const hypdriv = async () => undefined;
    expect(bothHandlers(hypdriv, undefined)).toBe(hypdriv);
  });

  it('runs Hypdriv’s handler and then the application’s, and raises a failure after both ran', async () => {
    const order: string[] = [];
    const both = bothHandlers(
      async (value: string) => void order.push(`hypdriv:${value}`),
      async (value: string) => void order.push(`own:${value}`),
    );
    await both('a');
    expect(order).toEqual(['hypdriv:a', 'own:a']);

    const failing = bothHandlers(
      async () => {
        order.push('hypdriv');
        throw new Error('hypdriv failed');
      },
      () => void order.push('own'),
    );
    await expect(failing()).rejects.toThrow('hypdriv failed');
    expect(order.slice(-2)).toEqual(['hypdriv', 'own']);
  });

  it('lets the picker route an event to one of them', async () => {
    const order: string[] = [];
    const picked = bothHandlers(
      async (kind: string) => void order.push(`hypdriv:${kind}`),
      async (kind: string) => void order.push(`own:${kind}`),
      (kind) => (kind === 'job' ? 'hypdriv' : 'own'),
    );
    await picked('job');
    await picked('other');
    expect(order).toEqual(['hypdriv:job', 'own:other']);
  });
});

describe('wrapCloudflare', () => {
  it('exports a Worker with fetch and the job handlers', () => {
    const worker = wrapCloudflare({} as never, false, options() as never) as unknown as Worker;
    for (const name of ['fetch', 'scheduled', 'queue', 'email', 'tail'])
      expect(typeof (worker as unknown as Record<string, unknown>)[name]).toBe('function');
  });

  it('runs the pipeline around Qwik with a nonce policy and gives Qwik the platform’s facts', async () => {
    const worker = wrapCloudflare({} as never, false, options() as never) as unknown as Worker;
    const response = await worker.fetch(
      new Request('https://shop.example/dynamic/', {
        headers: { ...BROWSER, 'cf-connecting-ip': '203.0.113.9', 'cf-ipcountry': 'US' },
      }),
      { GREETING: 'hello' },
      exec(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(/'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1]).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({
      method: 'GET',
      path: '/dynamic/',
      env: 'hello',
      clientConn: { ip: '203.0.113.9', country: 'US' },
    });
  });

  it('answers Qwik’s static paths from the assets binding', async () => {
    const log: string[] = [];
    const worker = wrapCloudflare({} as never, false, options() as never) as unknown as Worker;
    const env = { ASSETS: assets(log, { '/about/': '<!DOCTYPE html><html><body>static</body></html>' }) };
    const page = await worker.fetch(
      new Request('https://shop.example/about/', { headers: BROWSER }),
      env,
      exec(),
    );
    expect(await page.text()).toContain('static');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(log).toEqual(['GET /about/']);
    expect(fetched).toEqual([]);

    // A path that is not static, and other methods, reach Qwik.
    await worker.fetch(new Request('https://shop.example/dynamic/', { headers: BROWSER }), env, exec());
    await worker.fetch(new Request('https://shop.example/about/', { method: 'POST' }), env, exec());
    expect(fetched.map((f) => `${f.method} ${f.path}`)).toEqual(['GET /dynamic/', 'POST /about/']);
    expect(log).toEqual(['GET /about/']);
  });

  it('answers a missing static file with 404 and without the binding', async () => {
    const worker = wrapCloudflare(
      {} as never,
      false,
      options({ assets: false }) as never,
    ) as unknown as Worker;
    const log: string[] = [];
    const off = await worker.fetch(
      new Request('https://shop.example/build/q-x.js', { headers: { ...BROWSER, accept: '*/*' } }),
      { ASSETS: assets(log, { '/build/q-x.js': 'x' }) },
      exec(),
    );
    expect(off.status).toBe(404);
    expect(log).toEqual([]);

    const bare = wrapCloudflare({} as never, false, options() as never) as unknown as Worker;
    const missing = await bare.fetch(
      new Request('https://shop.example/about/', { headers: BROWSER }),
      {},
      exec(),
    );
    expect(missing.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  describe('with Qwik’s Cache API (`custom:qwikrouter`)', () => {
    const opened: string[] = [];
    const store = new Map<string, Response>();
    const cacheable = () =>
      new Response('<!DOCTYPE html><html><body><script>boot()</script></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
      });

    beforeEach(() => {
      opened.length = 0;
      store.clear();
      vi.stubGlobal('caches', {
        open: async (name: string) => {
          opened.push(name);
          return {
            match: async (request: Request) => store.get(request.url)?.clone(),
            put: async (request: Request, response: Response) => void store.set(request.url, response),
          };
        },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    const get = async (worker: Worker, path: string, headers: Record<string, string> = {}) => {
      const ctx = exec();
      const response = await worker.fetch(
        new Request(`https://shop.example${path}`, { headers: { ...BROWSER, ...headers } }),
        {},
        ctx,
      );
      await Promise.all(ctx.waiting);
      return response;
    };

    it('shares one entry between visitors, holding the document as Qwik rendered it', async () => {
      answer = cacheable;
      const worker = wrapCloudflare({} as never, true, options() as never) as unknown as Worker;
      const first = await get(worker, '/blog/');
      const second = await get(worker, '/blog/');
      expect(opened).toEqual(['custom:qwikrouter', 'custom:qwikrouter']);
      // Qwik rendered once; the second visitor was served from the cache.
      expect(fetched.map((f) => f.path)).toEqual(['/blog/']);
      expect(await second.text()).toContain('boot()');

      // The entry is the application’s response, not the pipeline’s: no policy, cookie or nonce of the first visitor.
      const entry = store.get('https://shop.example/blog/');
      expect(entry).toBeDefined();
      expect(entry?.headers.get('content-security-policy')).toBeNull();
      expect(entry?.headers.get('set-cookie')).toBeNull();
      expect(await entry?.clone().text()).not.toMatch(/nonce=/);

      // Each visitor still gets a policy of its own.
      const nonce = (response: Response) =>
        /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
      expect(nonce(first)).toBeTruthy();
      expect(nonce(second)).toBeTruthy();
      expect(nonce(second)).not.toBe(nonce(first));
    });

    it('does not use the cache for requests Qwik does not cache', async () => {
      answer = cacheable;
      const worker = wrapCloudflare({} as never, true, options() as never) as unknown as Worker;
      await get(worker, '/blog/', { cookie: 'session=1' });
      await get(worker, '/blog/', { authorization: 'Bearer x' });
      const post = exec();
      await worker.fetch(new Request('https://shop.example/blog/', { method: 'POST' }), {}, post);
      expect(store.size).toBe(0);
      expect(fetched).toHaveLength(3);

      const off = wrapCloudflare({} as never, false, options() as never) as unknown as Worker;
      await get(off, '/other/');
      await get(off, '/other/');
      expect(fetched.filter((f) => f.path === '/other/')).toHaveLength(2);
    });

    it('stores only responses a shared cache may keep', async () => {
      const worker = wrapCloudflare({} as never, true, options() as never) as unknown as Worker;
      const variants: Record<string, string>[] = [
        { 'cache-control': 'private, max-age=60' },
        { 'cache-control': 'no-store' },
        { 'cache-control': 'public, max-age=60', 'set-cookie': 'a=1' },
        {},
      ];
      for (const [index, headers] of variants.entries()) {
        answer = () =>
          new Response('<html></html>', { headers: { 'content-type': 'text/html', ...headers } });
        await get(worker, `/page-${index}/`);
      }
      expect(store.size).toBe(0);
      answer = () =>
        new Response('gone', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
      await get(worker, '/missing/');
      expect(store.size).toBe(0);
    });
  });

  it('answers with 404 when Qwik has no route and with 500 when it fails', async () => {
    const worker = wrapCloudflare({} as never, false, options() as never) as unknown as Worker;
    answer = () => null;
    const missing = await worker.fetch(
      new Request('https://shop.example/nope/', { headers: BROWSER }),
      {},
      exec(),
    );
    expect(missing.status).toBe(404);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer = () => {
      throw new Error('boom');
    };
    const failed = await worker.fetch(
      new Request('https://shop.example/bad/', { headers: BROWSER }),
      {},
      exec(),
    );
    expect(failed.status).toBe(500);
    // (Qwik’s `isDev` decides whether the message is shown; production builds answer with a generic body.)
    expect(failed.headers.get('x-error')).toBe('cloudflare');
    error.mockRestore();
  });

  it('runs the application’s handlers next to Hypdriv’s for the events the config does not name', async () => {
    const seen: string[] = [];
    const worker = wrapCloudflare(
      {} as never,
      false,
      options({
        handlers: {
          scheduled: async () => void seen.push('own:scheduled'),
          queue: async (batch: { queue: string }) => void seen.push(`own:queue:${batch.queue}`),
          tail: async () => void seen.push('own:tail'),
        },
      }) as never,
    ) as unknown as Worker;
    await worker.queue({ queue: 'unrelated', messages: [] }, {}, exec());
    await worker.tail([], {}, exec());
    expect(seen).toEqual(['own:queue:unrelated', 'own:tail']);
  });
});

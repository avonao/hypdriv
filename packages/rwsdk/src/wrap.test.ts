import { emptyManifest, type HypDrivConfig, type HypManifest } from '@hypdriv/core';
import { ensureContextStore } from '@hypdriv/runtime';
import { index, prefix, render, route } from 'rwsdk/router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HANDOFF_HEADER, hypdrivMiddleware, type NonceRequestInfo, wrapApp } from './wrap';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

// RedwoodSDK tells pages from endpoints by looking for compiled JSX (`jsx(...)`) in the handler's source.
const jsx = (tag: string): never => ({ tag }) as never;
const Home = () => jsx('main');
const Post = ({ params }: { params: { id: string } }) => jsx(params.id);
const ping = () => Response.json({ ok: true });

const SCRIPT_NONCE = 'rwsdk-own-nonce';

interface Calls {
  app: string[];
  assets: string[];
  nonces: Array<string | null>;
  rwNonces: string[];
  scheduled: string[];
  queue: string[];
  email: string[];
  tail: number;
}

const calls = (): Calls => ({
  app: [],
  assets: [],
  nonces: [],
  rwNonces: [],
  scheduled: [],
  queue: [],
  email: [],
  tail: 0,
});

interface FakeOptions {
  /** Run `hypdrivMiddleware()` the way RedwoodSDK runs the first route of `defineApp`. */
  middleware?: boolean;
  handlers?: Array<'scheduled' | 'queue' | 'email' | 'tail'>;
  nonceHeader?: string;
  middlewareFactory?: () => (info: NonceRequestInfo) => void;
  throws?: boolean;
}

/** What `defineApp(routes)` returns: a route table and a `fetch`, here without RedwoodSDK's Worker runtime. */
function fakeApp(c: Calls, options: FakeOptions = {}) {
  const { middleware = true, handlers = [], nonceHeader = 'x-nonce' } = options;
  const own: Record<string, unknown> = {};
  if (handlers.includes('scheduled'))
    own.scheduled = async (event: { cron: string }) => void c.scheduled.push(event.cron);
  if (handlers.includes('queue'))
    own.queue = async (batch: { queue: string }) => void c.queue.push(batch.queue);
  if (handlers.includes('email'))
    own.email = async (message: { from: string }) => void c.email.push(message.from);
  if (handlers.includes('tail')) own.tail = async () => void c.tail++;
  return {
    ...own,
    marker: 'kept',
    __rwRoutes: [
      render(
        ({ children }: { children?: unknown }) => jsx(String(children)),
        [index(Home), route('/posts/:id', Post), prefix('/blog', [route('/', Home)])],
      ),
      route('/api/ping', { get: ping }),
    ],
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      c.app.push(`${request.method} ${pathname}`);
      c.nonces.push(request.headers.get(nonceHeader));
      if (options.throws) throw new Error('rwsdk failed');
      if (pathname.startsWith('/api/')) return Response.json({ ok: true });
      // The first route of `defineApp`, then the document: RedwoodSDK renders its inline scripts with `rw.nonce`.
      const info: NonceRequestInfo = {
        request,
        rw: { nonce: SCRIPT_NONCE },
        response: { headers: new Headers() },
      };
      if (middleware) (options.middlewareFactory ?? hypdrivMiddleware)()(info);
      c.rwNonces.push(info.rw.nonce);
      const headers = new Headers(info.response.headers);
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(
        `<!DOCTYPE html><html><body><script nonce="${info.rw.nonce}">boot()</script></body></html>`,
        { headers },
      );
    },
  };
}

const assetsBinding = (c: Calls, files: Record<string, string>) => ({
  fetch: async (request: Request) => {
    const { pathname } = new URL(request.url);
    c.assets.push(`${request.method} ${pathname}`);
    const body = files[pathname];
    return body === undefined
      ? new Response('Not Found', { status: 404 })
      : new Response(body, { headers: { 'content-type': 'text/plain' } });
  },
});

const exec = () => {
  const waiting: Array<Promise<unknown>> = [];
  return { waitUntil: (p: Promise<unknown>) => void waiting.push(p), waiting };
};

const config = (overrides: Partial<HypDrivConfig> = {}): HypDrivConfig => ({
  site: { name: 'rwsdk-wrap-test' },
  jobs: {
    cron: { nightly: { cron: '0 3 * * *', path: '/api/jobs/nightly' } },
    queues: { mail: { path: '/api/jobs/mail' } },
  },
  ...overrides,
});

const build = (): HypManifest =>
  emptyManifest({
    buildId: 'build-1',
    framework: { name: 'rwsdk', version: '1.7.5', bundler: 'vite', adapter: 'cloudflare' },
    routes: [
      {
        id: 'page:/',
        pathname: '/',
        regex: '^/$',
        kind: 'page',
        classification: 'dynamic',
        runtime: 'nodejs',
        dynamic: false,
        assets: { js: ['/assets/client-abc.js'], css: ['/assets/app.css'], fonts: [] },
        sourcePage: 'src/worker.tsx',
      },
    ],
  });

type Worker = {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  scheduled(event: unknown, env: unknown, ctx: unknown): Promise<void>;
  queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
  email(message: unknown, env: unknown, ctx: unknown): Promise<void>;
  tail(events: unknown[], env: unknown, ctx: unknown): Promise<void>;
};

const page = (path: string, headers: Record<string, string> = BROWSER) =>
  new Request(`https://shop.example${path}`, { headers });

beforeAll(async () => {
  await ensureContextStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hypdrivMiddleware', () => {
  const info = (headers: Record<string, string> = {}): NonceRequestInfo => ({
    request: new Request('https://shop.example/', { headers }),
    rw: { nonce: SCRIPT_NONCE },
    response: { headers: new Headers() },
  });

  it('takes the nonce from the request when it runs outside the pipeline', () => {
    const request = info({ 'x-nonce': 'from-header' });
    hypdrivMiddleware()(request);
    expect(request.rw.nonce).toBe('from-header');
    expect(request.response.headers.get(HANDOFF_HEADER)).toBe('nonce');
  });

  it('leaves RedwoodSDK’s own nonce alone when the request has none', () => {
    const request = info();
    hypdrivMiddleware()(request);
    expect(request.rw.nonce).toBe(SCRIPT_NONCE);
    expect(request.response.headers.get(HANDOFF_HEADER)).toBe('none');
  });
});

describe('wrapApp', () => {
  it('keeps everything the app has and replaces its Worker handlers', () => {
    const c = calls();
    const app = fakeApp(c);
    const wrapped = wrapApp(app, { config: config(), manifest: build() });
    expect(wrapped.__rwRoutes).toBe(app.__rwRoutes);
    expect((wrapped as unknown as { marker: string }).marker).toBe('kept');
    expect(wrapped.fetch).not.toBe(app.fetch);
    for (const name of ['fetch', 'scheduled', 'queue', 'email', 'tail'] as const)
      expect(typeof wrapped[name]).toBe('function');
  });

  describe('the nonce hand-off', () => {
    it('renders RedwoodSDK’s scripts with the nonce the Content-Security-Policy allows', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      const response = await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(response.status).toBe(200);
      const token = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
      expect(token).toBeTruthy();
      // The nonce travelled on the forwarded request and became `rw.nonce`, replacing RedwoodSDK's own.
      expect(c.nonces).toEqual([token]);
      expect(c.rwNonces).toEqual([token]);
      expect(await response.text()).toContain(`<script nonce="${token}">boot()</script>`);
    });

    it('issues a new nonce for every request', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.rwNonces[0]).toBeTruthy();
      expect(c.rwNonces[1]).toBeTruthy();
      expect(c.rwNonces[0]).not.toBe(c.rwNonces[1]);
    });

    it('never lets the hand-off marker or a client’s own nonce header through', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      const response = await worker.fetch(
        page('/', { ...BROWSER, 'x-nonce': 'forged', [HANDOFF_HEADER]: 'nonce' }),
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(response.headers.get(HANDOFF_HEADER)).toBeNull();
      expect(c.nonces[0]).not.toBe('forged');
      expect(c.rwNonces[0]).not.toBe('forged');
    });

    it('follows a custom nonce header', async () => {
      const c = calls();
      const custom = config({ security: { csp: { nonceHeader: 'x-csp-nonce' } } });
      const worker = wrapApp(fakeApp(c, { nonceHeader: 'x-csp-nonce' }), {
        config: custom,
        manifest: build(),
      }) as unknown as Worker;
      const response = await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      const token = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
      expect(token).toBeTruthy();
      expect(c.nonces).toEqual([token]);
      expect(c.rwNonces).toEqual([token]);
    });
  });

  describe('a Worker without hypdrivMiddleware()', () => {
    // The report is made once per isolate, so each case starts from fresh modules.
    const fresh = async () => {
      vi.resetModules();
      const runtime = await import('@hypdriv/runtime');
      await runtime.ensureContextStore();
      return import('./wrap');
    };
    const errors = () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      return () => spy.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('CSP nonce'));
    };

    it('says what is wrong, once, when a page is rendered without the Drivetrain’s nonce', async () => {
      const read = errors();
      const wrap = await fresh();
      const c = calls();
      const worker = wrap.wrapApp(fakeApp(c, { middleware: false }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      const response = await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      await worker.fetch(page('/posts/1'), { ASSETS: assetsBinding(c, {}) }, exec());
      // The page carries RedwoodSDK's own nonce, which the policy does not allow.
      const token = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
      expect(await response.text()).toContain(`nonce="${SCRIPT_NONCE}"`);
      expect(token).not.toBe(SCRIPT_NONCE);
      const lines = read();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('/ was rendered without Hypdriv');
      expect(lines[0]).toContain('hypdrivMiddleware()');
      expect(lines[0]).toContain("'@hypdriv/rwsdk/worker'");
    });

    it('stays quiet when the middleware ran and for responses that are not pages', async () => {
      const read = errors();
      const wrap = await fresh();
      const c = calls();
      const worker = wrap.wrapApp(fakeApp(c, { middleware: false }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      await worker.fetch(page('/api/ping'), { ASSETS: assetsBinding(c, {}) }, exec());
      const withMiddleware = wrap.wrapApp(fakeApp(c, { middlewareFactory: wrap.hypdrivMiddleware }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      await withMiddleware.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(read()).toEqual([]);
    });
  });

  describe('the route manifest', () => {
    const manifestOf = async (worker: Worker, c: Calls) => {
      const response = await worker.fetch(
        page('/_hypdriv/dev/manifest'),
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as HypManifest;
    };

    it('is the routes of the running app, with the client assets the build recorded', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), {
        config: config(),
        manifest: build(),
        development: true,
      }) as unknown as Worker;
      const manifest = await manifestOf(worker, c);
      expect(manifest.routes.map((r) => r.id)).toEqual([
        'page:/',
        'page:/posts/[id]',
        'page:/blog',
        'endpoint:/api/ping',
      ]);
      expect(manifest.routes[0]?.assets.js).toEqual(['/assets/client-abc.js']);
      expect(manifest.routes[0]?.sourcePage).toBe('src/worker.tsx');
      expect(manifest.buildId).toBe('build-1');
      expect(manifest.framework?.name).toBe('rwsdk');
      expect(c.app).toEqual([]);
    });

    it('is the build’s with routes: "build"', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), {
        config: config(),
        manifest: build(),
        routes: 'build',
        development: true,
      }) as unknown as Worker;
      const manifest = await manifestOf(worker, c);
      expect(manifest.routes.map((r) => r.id)).toEqual(['page:/']);
    });

    it('falls back to the build’s when the route table cannot be read', async () => {
      const c = calls();
      const app = fakeApp(c);
      // `wrapApp` copies the app once (that read succeeds); the manifest reads the table from the original.
      let reads = 0;
      Object.defineProperty(app, '__rwRoutes', {
        get() {
          if (reads++ > 0) throw new Error('no table');
          return [];
        },
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const worker = wrapApp(app, {
        config: config(),
        manifest: build(),
        development: true,
      }) as unknown as Worker;
      const manifest = await manifestOf(worker, c);
      expect(manifest.routes.map((r) => r.id)).toEqual(['page:/']);
      expect(warn.mock.calls.flat().join(' ')).toContain(
        'route table of the app could not be read (no table)',
      );
    });
  });

  describe('static assets', () => {
    it('answers GET and HEAD from the assets binding first and sends misses and other methods to the app', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      const env = { ASSETS: assetsBinding(c, { '/robots.txt': 'User-agent: *' }) };
      const asset = await worker.fetch(page('/robots.txt'), env, exec());
      expect(await asset.text()).toBe('User-agent: *');
      expect(c.app).toEqual([]);

      await worker.fetch(page('/live'), env, exec());
      await worker.fetch(new Request('https://shop.example/robots.txt', { method: 'POST' }), env, exec());
      expect(c.app).toEqual(['GET /live', 'POST /robots.txt']);
      expect(c.assets).toEqual(['GET /robots.txt', 'GET /live']);
    });

    it('sends everything to the app with assets: false or without the binding', async () => {
      const c = calls();
      const off = wrapApp(fakeApp(c), {
        config: config(),
        manifest: build(),
        assets: false,
      }) as unknown as Worker;
      await off.fetch(page('/robots.txt'), { ASSETS: assetsBinding(c, { '/robots.txt': 'x' }) }, exec());
      const bare = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      await bare.fetch(page('/robots.txt'), {}, exec());
      expect(c.assets).toEqual([]);
      expect(c.app).toEqual(['GET /robots.txt', 'GET /robots.txt']);
    });

    it('reads the binding under another name', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), {
        config: config(),
        manifest: build(),
        assets: 'STATIC',
      }) as unknown as Worker;
      const response = await worker.fetch(
        page('/robots.txt'),
        { STATIC: assetsBinding(c, { '/robots.txt': 'static' }) },
        exec(),
      );
      expect(await response.text()).toBe('static');
      expect(c.app).toEqual([]);
    });
  });

  describe('the pipeline around the app', () => {
    it('adds the security headers and answers /_hypdriv/* without calling the app', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      const home = await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(home.headers.get('x-content-type-options')).toBe('nosniff');
      c.app.length = 0;
      const health = await worker.fetch(page('/_hypdriv/health'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(health.status).toBe(200);
      expect(c.app).toEqual([]);
    });

    it('blocks a bot before the app sees it', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      const response = await worker.fetch(
        page('/', { 'user-agent': 'curl/8.4.0', 'sec-fetch-mode': 'navigate', accept: 'text/html' }),
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(response.status).toBe(403);
      expect(c.app).toEqual([]);
    });

    it('shows a failure of the app through onError', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c, { throws: true }), {
        config: config(),
        manifest: build(),
        onError: (error) => new Response(`custom: ${error.message}`, { status: 599 }),
      }) as unknown as Worker;
      const response = await worker.fetch(page('/'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(response.status).toBe(599);
      expect(await response.text()).toBe('custom: rwsdk failed');
    });
  });

  describe('Worker events', () => {
    it('dispatches Hypdriv’s cron jobs through the app, next to the application’s own scheduled handler', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c, { handlers: ['scheduled'] }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      await worker.scheduled(
        { cron: '0 3 * * *', scheduledTime: Date.now() },
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(c.scheduled).toEqual(['0 3 * * *']);
      expect(c.app.some((entry) => entry.endsWith('/api/jobs/nightly'))).toBe(true);
    });

    it('works without handlers of the application', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c), { config: config(), manifest: build() }) as unknown as Worker;
      await worker.scheduled(
        { cron: '0 3 * * *', scheduledTime: Date.now() },
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(c.app.some((entry) => entry.endsWith('/api/jobs/nightly'))).toBe(true);
      expect(c.scheduled).toEqual([]);
    });

    it('gives queue batches to Hypdriv when a consumer is configured, else to the application', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c, { handlers: ['queue'] }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      const batch = (queue: string) => ({ queue, messages: [], ackAll: vi.fn(), retryAll: vi.fn() });
      await worker.queue(batch('mail'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.queue).toEqual([]);
      expect(c.app.some((entry) => entry.endsWith('/api/jobs/mail'))).toBe(true);
      await worker.queue(batch('thumbnails'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.queue).toEqual(['thumbnails']);
    });

    it('gives email to the application when no email job is configured', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c, { handlers: ['email'] }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      const message = {
        from: 'ada@example.com',
        to: 'hello@shop.example',
        headers: new Headers(),
        raw: new Response('hi').body,
        setReject: vi.fn(),
      };
      await worker.email(message, { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.email).toEqual(['ada@example.com']);
      expect(message.setReject).not.toHaveBeenCalled();
    });

    it('raises a failure of the application’s handler after Hypdriv’s ran', async () => {
      const c = calls();
      const app = fakeApp(c);
      (app as Record<string, unknown>).scheduled = async () => {
        throw new Error('own handler failed');
      };
      const worker = wrapApp(app, { config: config(), manifest: build() }) as unknown as Worker;
      await expect(
        worker.scheduled(
          { cron: '0 3 * * *', scheduledTime: Date.now() },
          { ASSETS: assetsBinding(c, {}) },
          exec(),
        ),
      ).rejects.toThrow('own handler failed');
      expect(c.app.some((entry) => entry.endsWith('/api/jobs/nightly'))).toBe(true);
    });

    it('forwards tail events to the application', async () => {
      const c = calls();
      const worker = wrapApp(fakeApp(c, { handlers: ['tail'] }), {
        config: config(),
        manifest: build(),
      }) as unknown as Worker;
      await worker.tail([], { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.tail).toBe(1);
    });
  });
});

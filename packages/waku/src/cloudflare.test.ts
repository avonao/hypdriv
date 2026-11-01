import { ensureContextStore } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CloudflareWrapOptions,
  DEFAULT_BUILD_PATH,
  isBuildRequest,
  wrapCloudflareEntry,
} from './cloudflare';
import type { WakuServerEntry } from './entry';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const options = (overrides: Partial<CloudflareWrapOptions> = {}): CloudflareWrapOptions => ({
  config: {
    site: { name: 'waku-worker-test' },
    jobs: {
      cron: { nightly: { cron: '0 3 * * *', path: '/api/jobs/nightly' } },
      queues: { mail: { path: '/api/jobs/mail' } },
    },
  },
  manifest: null,
  development: false,
  ...overrides,
});

interface Calls {
  waku: string[];
  assets: string[];
  scheduled: string[];
  queue: string[];
  email: string[];
  tail: number;
}

/** Waku's Cloudflare adapter output: `fetch` for Vite's middleware and a Worker with the application's handlers. */
function fakeEntry(
  calls: Calls,
  handlers: Array<'scheduled' | 'queue' | 'email' | 'tail'> = [],
): WakuServerEntry {
  const own: Record<string, unknown> = {};
  if (handlers.includes('scheduled'))
    own.scheduled = async (event: { cron: string }) => void calls.scheduled.push(event.cron);
  if (handlers.includes('queue'))
    own.queue = async (batch: { queue: string }) => void calls.queue.push(batch.queue);
  if (handlers.includes('email'))
    own.email = async (message: { from: string }) => void calls.email.push(message.from);
  if (handlers.includes('tail')) own.tail = async () => void calls.tail++;
  const fetchFn = async (request: Request) => {
    calls.waku.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response('<!DOCTYPE html><html><body><script>boot()</script></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  return {
    fetch: fetchFn,
    build: async () => undefined,
    buildOptions: { distDir: 'dist' },
    buildEnhancers: ['waku/adapters/cloudflare-build-enhancer'],
    defaultExport: { ...own, fetch: (request: Request) => fetchFn(request) },
  };
}

const assetsBinding = (calls: Calls, files: Record<string, string>) => ({
  fetch: async (request: Request) => {
    const { pathname } = new URL(request.url);
    calls.assets.push(`${request.method} ${pathname}`);
    const body = files[pathname];
    return body === undefined
      ? new Response('Not Found', { status: 404 })
      : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

const exec = () => {
  const waiting: Array<Promise<unknown>> = [];
  return { waitUntil: (p: Promise<unknown>) => void waiting.push(p), waiting };
};

const calls = (): Calls => ({ waku: [], assets: [], scheduled: [], queue: [], email: [], tail: 0 });

type Worker = {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  scheduled(event: unknown, env: unknown, ctx: unknown): Promise<void>;
  queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
  email(message: unknown, env: unknown, ctx: unknown): Promise<void>;
  tail(events: unknown[], env: unknown, ctx: unknown): Promise<void>;
};
const workerOf = (entry: WakuServerEntry) => entry.defaultExport as Worker;

beforeAll(async () => {
  await ensureContextStore();
});

describe('isBuildRequest', () => {
  const at = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  it('matches Waku’s static-generation request on a loopback host only', () => {
    expect(isBuildRequest(at(`http://localhost:4173/${DEFAULT_BUILD_PATH}`))).toBe(true);
    expect(isBuildRequest(at(`http://127.0.0.1:4173/${DEFAULT_BUILD_PATH}`))).toBe(true);
    expect(isBuildRequest(at(`http://[::1]:4173/${DEFAULT_BUILD_PATH}`))).toBe(true);
    expect(isBuildRequest(at(`https://shop.example/${DEFAULT_BUILD_PATH}`))).toBe(false);
    expect(isBuildRequest(at('http://localhost:4173/about'))).toBe(false);
  });

  it('never matches a request that carries cf-visitor (production Workers)', () => {
    expect(
      isBuildRequest(at(`http://localhost/${DEFAULT_BUILD_PATH}`, { 'cf-visitor': '{"scheme":"https"}' })),
    ).toBe(false);
  });

  it('follows the adapter option', () => {
    expect(isBuildRequest(at('http://localhost/__custom_build'), '__custom_build')).toBe(true);
    expect(isBuildRequest(at('http://localhost/__custom_build'), '/__custom_build')).toBe(true);
    expect(isBuildRequest(at(`http://localhost/${DEFAULT_BUILD_PATH}`), '__custom_build')).toBe(false);
  });
});

describe('wrapCloudflareEntry', () => {
  it('replaces the Worker with the Hypdriv shell and keeps the rest of the entry', async () => {
    const entry = fakeEntry(calls());
    const wrapped = wrapCloudflareEntry(entry, options());
    expect(wrapped.build).toBe(entry.build);
    expect(wrapped.buildEnhancers).toEqual(['waku/adapters/cloudflare-build-enhancer']);
    expect(wrapped.buildOptions).toEqual({ distDir: 'dist' });
    expect(wrapped.defaultExport).not.toBe(entry.defaultExport);
    for (const name of ['fetch', 'scheduled', 'queue', 'email', 'tail'])
      expect(typeof (wrapped.defaultExport as Record<string, unknown>)[name]).toBe('function');
  });

  it('runs the pipeline around Waku, with a nonce policy (HTMLRewriter adds it to the scripts in workerd)', async () => {
    const c = calls();
    const worker = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
    const response = await worker.fetch(
      new Request('https://shop.example/account', { headers: BROWSER }),
      { ASSETS: assetsBinding(c, {}) },
      exec(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const token = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(token).toBeTruthy();
    // `HTMLRewriter` (workerd only) puts the nonce on Waku's inline scripts; the live check covers that.
    expect(c.waku).toEqual(['GET /account']);
  });

  it('answers GET and HEAD from the assets binding first, so prerendered pages stay static files', async () => {
    const c = calls();
    const worker = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
    const env = { ASSETS: assetsBinding(c, { '/about': '<!DOCTYPE html><html><body>static</body></html>' }) };
    const asset = await worker.fetch(
      new Request('https://shop.example/about', { headers: BROWSER }),
      env,
      exec(),
    );
    expect(await asset.text()).toContain('static');
    expect(c.waku).toEqual([]);
    expect(c.assets).toEqual(['GET /about']);

    // A miss falls through to Waku; so do other methods (server functions, API routes).
    await worker.fetch(new Request('https://shop.example/live', { headers: BROWSER }), env, exec());
    await worker.fetch(new Request('https://shop.example/about', { method: 'POST' }), env, exec());
    expect(c.waku).toEqual(['GET /live', 'POST /about']);
    expect(c.assets).toEqual(['GET /about', 'GET /live']);
  });

  it('sends everything to Waku with assets: false or without the binding', async () => {
    const c = calls();
    const off = workerOf(wrapCloudflareEntry(fakeEntry(c), options({ assets: false })));
    await off.fetch(
      new Request('https://shop.example/about', { headers: BROWSER }),
      { ASSETS: assetsBinding(c, { '/about': 'x' }) },
      exec(),
    );
    const bare = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
    await bare.fetch(new Request('https://shop.example/about', { headers: BROWSER }), {}, exec());
    expect(c.assets).toEqual([]);
    expect(c.waku).toEqual(['GET /about', 'GET /about']);
  });

  it('lets the build’s static-generation request through to Waku untouched', async () => {
    const c = calls();
    const worker = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
    const build = await worker.fetch(
      new Request(`http://localhost:4173/${DEFAULT_BUILD_PATH}`),
      { ASSETS: assetsBinding(c, {}) },
      exec(),
    );
    expect(c.waku).toEqual([`GET /${DEFAULT_BUILD_PATH}`]);
    // No request stages ran: the generated files carry no nonce, request id or security headers.
    expect(build.headers.get('content-security-policy')).toBeNull();
    expect(build.headers.get('x-content-type-options')).toBeNull();
    expect(await build.text()).toContain('<script>boot()</script>');
  });

  it('runs the pipeline for the same path in production (cf-visitor)', async () => {
    const c = calls();
    const worker = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
    const response = await worker.fetch(
      new Request(`https://shop.example/${DEFAULT_BUILD_PATH}`, {
        headers: { ...BROWSER, 'cf-visitor': '{"scheme":"https"}' },
      }),
      { ASSETS: assetsBinding(c, {}) },
      exec(),
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers /_hypdriv/* without calling Waku', async () => {
    const c = calls();
    const worker = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
    const response = await worker.fetch(
      new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }),
      { ASSETS: assetsBinding(c, {}) },
      exec(),
    );
    expect(response.status).toBe(200);
    expect(c.waku).toEqual([]);
  });

  describe('Worker events', () => {
    it('dispatches Hypdriv’s cron jobs through the app, next to the application’s own scheduled handler', async () => {
      const c = calls();
      const worker = workerOf(wrapCloudflareEntry(fakeEntry(c, ['scheduled']), options()));
      await worker.scheduled(
        { cron: '0 3 * * *', scheduledTime: Date.now() },
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(c.scheduled).toEqual(['0 3 * * *']);
      expect(c.waku.some((entry) => entry.endsWith('/api/jobs/nightly'))).toBe(true);
    });

    it('works without handlers of the application', async () => {
      const c = calls();
      const worker = workerOf(wrapCloudflareEntry(fakeEntry(c), options()));
      await worker.scheduled(
        { cron: '0 3 * * *', scheduledTime: Date.now() },
        { ASSETS: assetsBinding(c, {}) },
        exec(),
      );
      expect(c.waku.some((entry) => entry.endsWith('/api/jobs/nightly'))).toBe(true);
      expect(c.scheduled).toEqual([]);
    });

    it('gives queue batches to Hypdriv when a consumer is configured, else to the application', async () => {
      const c = calls();
      const worker = workerOf(wrapCloudflareEntry(fakeEntry(c, ['queue']), options()));
      const batch = (queue: string) => ({
        queue,
        messages: [],
        ackAll: vi.fn(),
        retryAll: vi.fn(),
      });
      await worker.queue(batch('mail'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.queue).toEqual([]);
      expect(c.waku.some((entry) => entry.endsWith('/api/jobs/mail'))).toBe(true);
      await worker.queue(batch('thumbnails'), { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.queue).toEqual(['thumbnails']);
    });

    it('gives email to Hypdriv only when an email job is configured', async () => {
      const c = calls();
      const without = workerOf(wrapCloudflareEntry(fakeEntry(c, ['email']), options()));
      const message = () => ({
        from: 'ada@example.com',
        to: 'hello@shop.example',
        headers: new Headers(),
        raw: new Response('hi').body,
        setReject: vi.fn(),
      });
      const rejected = message();
      await without.email(rejected, { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.email).toEqual(['ada@example.com']);
      expect(rejected.setReject).not.toHaveBeenCalled();
    });

    it('raises a failure of the application’s handler after Hypdriv’s ran', async () => {
      const c = calls();
      const entry = fakeEntry(c);
      (entry.defaultExport as Record<string, unknown>).scheduled = async () => {
        throw new Error('own handler failed');
      };
      const worker = workerOf(wrapCloudflareEntry(entry, options()));
      await expect(
        worker.scheduled(
          { cron: '0 3 * * *', scheduledTime: Date.now() },
          { ASSETS: assetsBinding(c, {}) },
          exec(),
        ),
      ).rejects.toThrow('own handler failed');
      expect(c.waku.some((entry) => entry.endsWith('/api/jobs/nightly'))).toBe(true);
    });

    it('forwards tail events to both', async () => {
      const c = calls();
      const worker = workerOf(wrapCloudflareEntry(fakeEntry(c, ['tail']), options()));
      await worker.tail([], { ASSETS: assetsBinding(c, {}) }, exec());
      expect(c.tail).toBe(1);
    });
  });

  describe('outside the Workers runtime', () => {
    it('wraps Waku’s own fetch (Vite’s development middleware, INTERNAL_runFetch) in the same pipeline', async () => {
      const c = calls();
      const wrapped = wrapCloudflareEntry(fakeEntry(c), options({ target: 'node' }));
      const response = await wrapped.fetch(new Request('https://shop.example/account', { headers: BROWSER }));
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(c.waku).toEqual(['GET /account']);
    });

    it('passes the build request straight through', async () => {
      const c = calls();
      const wrapped = wrapCloudflareEntry(fakeEntry(c), options({ target: 'node' }));
      const response = await wrapped.fetch(new Request(`http://localhost:5173/${DEFAULT_BUILD_PATH}`));
      expect(response.headers.get('content-security-policy')).toBeNull();
    });
  });
});

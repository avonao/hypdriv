import { emptyManifest } from '@hypdriv/core';
import { ensureContextStore, hyp, nonce } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSolidStartWorker,
  type SolidStartServerEntry,
  startApp,
  withCloudflareRuntime,
} from './cloudflare';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US',
};

beforeAll(async () => {
  await ensureContextStore();
});

const context = () => {
  const waiting: Array<Promise<unknown>> = [];
  return { waitUntil: (p: Promise<unknown>) => void waiting.push(p), passThroughOnException() {}, waiting };
};

interface Seen {
  request: Request;
  nonce: string | undefined;
  runner: string | null;
}

/** SolidStart's server entry: the H3 app `createHandler()` returns, with Solid's inline scripts in the HTML. */
function solidEntry(seen: Seen[] = []): SolidStartServerEntry {
  return {
    fetch: async (request: Request) => {
      seen.push({ request, nonce: nonce(), runner: hyp()?.runner ?? null });
      return new Response(
        '<!DOCTYPE html><html><head><title>t</title></head><body><script>window._$HY||1</script></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  };
}

const assetsBinding = (files: Record<string, string>, seen: string[] = []) => ({
  fetch: async (request: Request) => {
    const { pathname } = new URL(request.url);
    seen.push(`${request.method} ${pathname}`);
    const body = files[pathname];
    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body);
  },
});

describe('withCloudflareRuntime', () => {
  it('exposes env and ctx as request.runtime.cloudflare, the way srvx does for other runtimes', () => {
    const env = { KV: {} };
    const ctx = context();
    const request = withCloudflareRuntime(new Request('https://shop.example/'), env, ctx) as Request & {
      runtime?: { name: string; cloudflare: { env: unknown; context: unknown } };
    };
    expect(request.runtime?.name).toBe('cloudflare');
    expect(request.runtime?.cloudflare.env).toBe(env);
    expect(request.runtime?.cloudflare.context).toBe(ctx);
    expect(Object.keys(request)).toEqual([]);
  });

  it('copies a request that refuses the property', () => {
    const frozen = Object.freeze(new Request('https://shop.example/x'));
    const out = withCloudflareRuntime(frozen, {}, context()) as Request & { runtime?: unknown };
    expect(out).not.toBe(frozen);
    expect(out.url).toBe('https://shop.example/x');
    expect(out.runtime).toBeDefined();
  });
});

describe('startApp', () => {
  it('answers GET and HEAD from the assets binding first and falls through on 404', async () => {
    const calls: string[] = [];
    const app = await startApp(async () => ({ default: solidEntry() }))();
    const env = { ASSETS: assetsBinding({ '/robots.txt': 'User-agent: *' }, calls) };

    const robots = await app.fetch(new Request('https://shop.example/robots.txt'), env, context());
    expect(await robots.text()).toBe('User-agent: *');
    const page = await app.fetch(new Request('https://shop.example/about'), env, context());
    expect(page.headers.get('content-type')).toContain('text/html');
    await app.fetch(new Request('https://shop.example/robots.txt', { method: 'HEAD' }), env, context());
    expect(calls).toEqual(['GET /robots.txt', 'GET /about', 'HEAD /robots.txt']);
  });

  it('sends other methods straight to SolidStart', async () => {
    const calls: string[] = [];
    const seen: Seen[] = [];
    const app = await startApp(async () => solidEntry(seen))();
    await app.fetch(
      new Request('https://shop.example/_server', { method: 'POST', body: 'x' }),
      { ASSETS: assetsBinding({}, calls) },
      context(),
    );
    expect(calls).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('can do without the binding', async () => {
    const calls: string[] = [];
    const seen: Seen[] = [];
    const app = await startApp(async () => solidEntry(seen), false)();
    await app.fetch(
      new Request('https://shop.example/robots.txt'),
      { ASSETS: assetsBinding({}, calls) },
      context(),
    );
    expect(calls).toEqual([]);
    expect(seen).toHaveLength(1);
    // A missing binding is no error either.
    await startApp(async () => solidEntry(seen))().then((a) =>
      a.fetch(new Request('https://shop.example/'), {}, context()),
    );
    expect(seen).toHaveLength(2);
  });

  it('hands SolidStart the bindings through request.runtime.cloudflare', async () => {
    const seen: Seen[] = [];
    const app = await startApp(async () => solidEntry(seen))();
    const env = { MY_KV: { id: 1 } };
    const ctx = context();
    await app.fetch(new Request('https://shop.example/about'), env, ctx);
    const request = seen[0]?.request as Request & {
      runtime?: { cloudflare: { env: unknown; context: unknown } };
    };
    const runtime = request.runtime;
    expect(runtime?.cloudflare.env).toBe(env);
    expect(runtime?.cloudflare.context).toBe(ctx);
  });
});

describe('createSolidStartWorker', () => {
  const worker = (seen: Seen[] = [], files: Record<string, string> = {}) => ({
    worker: createSolidStartWorker({
      config: { site: { name: 'solid-worker-test' }, security: { bots: { definitelyAutomated: 'block' } } },
      manifest: emptyManifest({ buildId: 'test', framework: { name: 'solid-start', version: '2.1.0' } }),
      entry: async () => ({ default: solidEntry(seen) }),
      development: false,
    }),
    env: { ASSETS: assetsBinding(files) },
  });

  it('runs the shell around SolidStart: headers, a CSP nonce handed to the render, request context', async () => {
    const seen: Seen[] = [];
    const { worker: w, env } = worker(seen);
    const response = await w.fetch(
      new Request('https://shop.example/request', { headers: BROWSER }),
      env,
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const token = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(token).toBeTruthy();
    // The nonce is what `hypdrivStart()` gives Solid; stamping the inline scripts of HTML that lacks it is
    // HTMLRewriter's job in the Worker shell (workerd only: verified by the `wrangler dev` run of the example).
    expect(seen[0]?.nonce).toBe(token);
    expect(seen[0]?.runner).toBe('worker');
  });

  it('answers /_hypdriv/* itself and serves assets before SolidStart', async () => {
    const seen: Seen[] = [];
    const { worker: w, env } = worker(seen, { '/favicon.svg': '<svg/>' });
    const health = await w.fetch(
      new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }),
      env,
      context(),
    );
    expect(await health.json()).toMatchObject({
      runner: 'worker',
      framework: expect.stringContaining('SolidStart'),
    });
    const icon = await w.fetch(
      new Request('https://shop.example/favicon.svg', { headers: { ...BROWSER, accept: '*/*' } }),
      env,
      context(),
    );
    expect(await icon.text()).toBe('<svg/>');
    expect(seen).toHaveLength(0);
  });

  it('stops automation before SolidStart renders anything', async () => {
    const seen: Seen[] = [];
    const { worker: w, env } = worker(seen);
    const response = await w.fetch(
      new Request('https://shop.example/request', {
        headers: { 'user-agent': 'curl/8.9.1', accept: 'text/html' },
      }),
      env,
      context(),
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('exposes the event handlers Cloudflare calls', () => {
    const { worker: w } = worker();
    for (const handler of ['fetch', 'scheduled', 'queue', 'email', 'tail'] as const)
      expect(typeof w[handler]).toBe('function');
  });
});

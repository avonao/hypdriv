import { emptyManifest, type HypManifest, routePatternToRegex } from '@hypdriv/core';
import { hyp } from '@hypdriv/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRERENDER_TOKEN_ENV, wrapAppHandler } from './runtime';
import { createVinextWorker } from './worker';

const manifest: HypManifest = emptyManifest({
  framework: { name: 'vinext', version: '1.4.0', bundler: 'vite' },
  routes: [
    {
      id: 'page:/account',
      pathname: '/account',
      regex: routePatternToRegex('/account'),
      kind: 'page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
});

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const get = (path: string) =>
  new Request(`https://example.com${path}`, {
    headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US' },
  });
const exec = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) } };
};

/** vinext's Worker handler with the plugin's request hook inside, as a build produces it. */
function vinextWorker(calls: { runner: string | null }[]) {
  const rsc = wrapAppHandler(
    async (request: Request, _ctx?: unknown) => {
      calls.push({ runner: hyp()?.runner ?? null });
      const nonce = /'nonce-([^']+)'/.exec(request.headers.get('content-security-policy') ?? '')?.[1];
      return new Response(
        `<html><body><script${nonce ? ` nonce="${nonce}"` : ''}>x()</script></body></html>`,
        {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      );
    },
    { config: {}, manifest, target: 'cloudflare' },
  );
  return { fetch: (request: Request, _env: unknown, ctx: unknown) => rsc(request, ctx) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createVinextWorker', () => {
  it('runs the Worker shell around vinext; the in-app hook passes through', async () => {
    const calls: { runner: string | null }[] = [];
    const worker = createVinextWorker({ config: {}, manifest, app: vinextWorker(calls) as never });
    const { ctx } = exec();
    const response = await worker.fetch(get('/account'), {}, ctx);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ runner: 'worker' }]);
    // One pipeline: one policy, one request id.
    expect(response.headers.get('content-security-policy')?.split('script-src').length).toBe(2);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    const health = (await (await worker.fetch(get('/_hypdriv/health'), {}, ctx)).json()) as {
      runner: string;
    };
    expect(health.runner).toBe('worker');
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });

  it('accepts a module loader and hands vinext’s build-time prerender straight to vinext', async () => {
    const calls: { runner: string | null }[] = [];
    const app = vi.fn(async () => ({ default: vinextWorker(calls) as never }));
    const worker = createVinextWorker({ config: {}, manifest, app });
    vi.stubEnv('VINEXT_PRERENDER', '1');
    vi.stubEnv(PRERENDER_TOKEN_ENV, 'build-token');
    vi.stubGlobal('__HYPDRIV_VINEXT_PRERENDER_TOKEN__', 'build-token');
    try {
      const { ctx } = exec();
      const response = await worker.fetch(get('/account'), {}, ctx);
      expect(response.headers.get('x-request-id')).toBeNull();
      expect(calls).toEqual([{ runner: null }]);
      expect(app).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

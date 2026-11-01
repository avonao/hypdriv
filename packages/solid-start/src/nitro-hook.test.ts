import { emptyManifest } from '@hypdriv/core';
import { createHandler, ensureContextStore, hyp, nonce } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRequest } from './entry';
import { installFetchHook, isPrivateBuildPath, type NitroAppLike, solidSkip } from './nitro-hook';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

beforeAll(async () => {
  await ensureContextStore();
});

interface Seen {
  request: Request;
  nonce: string | undefined;
  runner: string | null;
}

/** Nitro's app as the hook sees it: `fetch` returns SolidStart-shaped HTML with Solid's hydration script. */
function nitroApp(seen: Seen[] = []): NitroAppLike & { calls: number } {
  const app = {
    calls: 0,
    fetch: async (request: Request) => {
      app.calls++;
      seen.push({ request, nonce: nonce(), runner: hyp()?.runner ?? null });
      const { pathname } = new URL(request.url);
      if (pathname === '/_build/assets/entry-abc123.js')
        return new Response('boot()', { headers: { 'content-type': 'text/javascript' } });
      if (pathname === '/api/time') return Response.json({ ok: true });
      return new Response(
        '<!DOCTYPE html><html><head><title>t</title></head><body><div>hi</div><script>window._$HY||(e=>{})</script><script>_$HY.r["x"]=1</script></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  };
  return app;
}

const handler = (development = false) =>
  createHandler({
    config: { site: { name: 'solid-test' }, security: { bots: { definitelyAutomated: 'block' } } },
    manifest: emptyManifest({ buildId: 'test', framework: { name: 'solid-start', version: '2.1.0' } }),
    host: 'solid-start',
    target: 'node',
    development,
    skip: solidSkip(['/_build/assets/']),
  });

describe('solidSkip', () => {
  const skip = solidSkip(['/_build/assets/']);
  it('skips content-hashed build assets and media, not documents or API routes', () => {
    expect(skip(new URL('https://shop.example/_build/assets/entry-abc123.js'))).toBe(true);
    expect(skip(new URL('https://shop.example/logo.png'))).toBe(true);
    expect(skip(new URL('https://shop.example/'))).toBe(false);
    expect(skip(new URL('https://shop.example/about'))).toBe(false);
    expect(skip(new URL('https://shop.example/api/time'))).toBe(false);
    expect(skip(new URL('https://shop.example/_server'))).toBe(false);
  });

  it('follows a base path', () => {
    const based = solidSkip(['/app/_build/assets/']);
    expect(based(new URL('https://shop.example/app/_build/assets/chunk'))).toBe(true);
    expect(based(new URL('https://shop.example/_build/assets/chunk'))).toBe(false);
  });
});

describe('isPrivateBuildPath', () => {
  it('matches build metadata directories, however they are spelled', () => {
    for (const url of [
      'https://shop.example/.vite/manifest.json',
      'https://shop.example/.hypdriv/manifest.json',
      'https://shop.example/.VITE/manifest.json',
      'https://shop.example/%2Evite/manifest.json',
      'https://shop.example/.vite',
    ])
      expect(isPrivateBuildPath(url), url).toBe(true);
  });

  it('leaves everything else, including malformed input, alone', () => {
    for (const url of [
      'https://shop.example/',
      'https://shop.example/.well-known/security.txt',
      'https://shop.example/a/.vite/manifest.json',
      'https://shop.example/%E0%A4%A/manifest.json',
      'not a url',
    ])
      expect(isPrivateBuildPath(url), url).toBe(false);
  });
});

describe('installFetchHook', () => {
  it('runs the pipeline around nitroApp.fetch: headers, CSP nonce on Solid’s inline scripts, request context', async () => {
    const seen: Seen[] = [];
    const app = nitroApp(seen);
    installFetchHook(app, { handler: handler() });
    const response = await app.fetch(new Request('https://shop.example/request', { headers: BROWSER }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const token = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(token).toBeTruthy();
    const html = await response.text();
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${token}"`);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    // The application runs inside the request context: the nonce and runner are readable.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.nonce).toBe(token);
    expect(seen[0]?.runner).toBe('host');
  });

  it('answers /_hypdriv/* itself', async () => {
    const app = nitroApp();
    installFetchHook(app, { handler: handler() });
    const health = await app.fetch(new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      runner: 'host',
      framework: expect.stringContaining('SolidStart'),
    });
    expect(app.calls).toBe(0);
  });

  it('passes skipped assets straight to Nitro without the stages', async () => {
    const app = nitroApp();
    installFetchHook(app, { handler: handler() });
    const response = await app.fetch(
      new Request('https://shop.example/_build/assets/entry-abc123.js', {
        headers: { ...BROWSER, accept: '*/*' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(app.calls).toBe(1);
  });

  it('never serves build metadata Nitro copied into the public directory', async () => {
    const app = nitroApp();
    installFetchHook(app, { handler: handler() });
    for (const path of ['/.vite/manifest.json', '/.hypdriv/manifest.json']) {
      const response = await app.fetch(new Request(`https://shop.example${path}`, { headers: BROWSER }));
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(app.calls).toBe(0);
  });

  it('stops automation before the application', async () => {
    const app = nitroApp();
    installFetchHook(app, { handler: handler() });
    const response = await app.fetch(
      new Request('https://shop.example/request', {
        headers: { 'user-agent': 'curl/8.9.1', accept: 'text/html' },
      }),
    );
    expect(response.status).toBe(403);
    expect(app.calls).toBe(0);
  });

  it('strips client-supplied x-hypdriv-* headers before the application sees the request', async () => {
    const seen: Seen[] = [];
    const app = nitroApp(seen);
    installFetchHook(app, { handler: handler() });
    await app.fetch(
      new Request('https://shop.example/api/time', {
        headers: { ...BROWSER, 'x-hypdriv-bot': 'verified', 'x-hypdriv-purge': 'secret' },
      }),
    );
    expect(seen[0]?.request.headers.get('x-hypdriv-bot')).not.toBe('verified');
    expect(seen[0]?.request.headers.get('x-hypdriv-purge')).toBeNull();
  });

  it('hands the original request’s platform facts to the application', async () => {
    const seen: Seen[] = [];
    const app = nitroApp(seen);
    installFetchHook(app, { handler: handler() });
    const runtime = { name: 'node', node: { req: {}, res: {} } };
    const request = new Request('https://shop.example/api/time', { headers: BROWSER });
    Object.defineProperty(request, 'runtime', { value: runtime });
    Object.defineProperty(request, 'ip', { value: '203.0.113.9' });
    await app.fetch(request);
    const forwarded = seen[0]?.request as PlatformRequest;
    expect(forwarded.runtime).toBe(runtime);
    expect(forwarded.ip).toBe('203.0.113.9');
  });

  it('answers a failing application with the 500 of the error handler, not an unhandled rejection', async () => {
    const app: NitroAppLike = {
      fetch: async () => {
        throw new Error('boom');
      },
    };
    const failing = createHandler({
      config: { site: { name: 'solid-test' } },
      manifest: emptyManifest({ buildId: 'test' }),
      host: 'solid-start',
      target: 'node',
      onError: () => new Response('failed', { status: 500 }),
    });
    installFetchHook(app, { handler: failing });
    const response = await app.fetch(new Request('https://shop.example/', { headers: BROWSER }));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('failed');
  });
});

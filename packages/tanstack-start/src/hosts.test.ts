import { prerenderToken } from 'virtual:hypdriv/tanstack-start';
import { getCurrentContext } from '@hypdriv/core';
import { nonce } from '@hypdriv/runtime';
import { describe, expect, it, vi } from 'vitest';
import { createStartWorker, startApp } from './cloudflare';
import { PRERENDER_HEADER } from './constants';
import { createHypDrivServerEntry } from './server-entry';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US',
};

const page = (n?: string) =>
  new Response(
    `<!doctype html><html><head><script${n ? ` nonce="${n}"` : ''}>boot()</script></head><body></body></html>`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );

describe('server entry (src/server.ts)', () => {
  it('runs the pipeline outside Start and hands the nonce to Start in the request context', async () => {
    let seen: { runner?: string; nonce?: string; context?: Record<string, unknown> } = {};
    const entry = createHypDrivServerEntry({
      target: 'node',
      development: false,
      handler: {
        fetch: (_request, opts) => {
          const context = (opts as { context?: Record<string, unknown> } | undefined)?.context;
          seen = { runner: getCurrentContext()?.runner, nonce: nonce(), context };
          return page(context?.nonce as string);
        },
      },
    });
    const response = await entry.fetch(new Request('https://shop.example/request', { headers: BROWSER }), {
      context: { tenant: 'us' },
    } as never);
    const header = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(seen.runner).toBe('host');
    expect(seen.nonce).toBe(header);
    expect(seen.context).toEqual({ tenant: 'us', nonce: header });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it("sends Start's prerender requests straight to Start", async () => {
    const fetch = vi.fn(() => page());
    const entry = createHypDrivServerEntry({ handler: { fetch } });
    const response = await entry.fetch(
      new Request('https://localhost/about', { headers: { ...BROWSER, [PRERENDER_HEADER]: prerenderToken } }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get('x-request-id')).toBeNull();
  });
});

describe('Cloudflare Worker (createStartWorker)', () => {
  const env = {};
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

  it('runs the shell around Start and passes Workers env/ctx as context.cloudflare', async () => {
    let received: { context?: unknown; runner?: string } = {};
    const worker = createStartWorker({
      config: { site: { name: 'cf' } },
      development: false,
      entry: async () => ({
        fetch: (_request, opts) => {
          received = { context: opts?.context, runner: getCurrentContext()?.runner };
          return page();
        },
      }),
    });
    const response = await worker.fetch(
      new Request('https://shop.example/request', { headers: BROWSER }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(received.runner).toBe('worker');
    expect(received.context).toEqual({ cloudflare: { env, ctx } });
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.email).toBe('function');
  });

  it('lets prerender requests reach Start untouched (the shell would strip the marker and add a nonce)', async () => {
    let header: string | null = null;
    const worker = createStartWorker({
      config: {},
      entry: async () => ({
        default: {
          fetch: (request: Request) => {
            header = request.headers.get(PRERENDER_HEADER);
            return page();
          },
        },
      }),
    });
    const response = await worker.fetch(
      new Request('https://localhost/about', { headers: { ...BROWSER, [PRERENDER_HEADER]: prerenderToken } }),
      env,
      ctx,
    );
    expect(header).toBe(prerenderToken);
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('builds the application worker createWorker({ app }) expects', async () => {
    const fetch = vi.fn(() => new Response('ok'));
    const app = await startApp(async () => ({ fetch }))();
    await app.fetch(new Request('https://x/'), env, ctx);
    expect(fetch).toHaveBeenCalledWith(expect.any(Request), { context: { cloudflare: { env, ctx } } });
  });
});

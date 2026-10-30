import {
  emptyManifest,
  getCurrentContext,
  type HypManifest,
  routePatternToRegex,
  sha256Hex,
} from '@hypdriv/core';
import { signing } from '@hypdriv/security';
import { createFakeExecutionContext, createFakeKV } from '@hypdriv/testing';
import { describe, expect, it, vi } from 'vitest';
import { createWorker, type NextWorkerModule } from './worker';

const manifest: HypManifest = emptyManifest({
  buildId: 'build-42',
  nextVersion: '16.4.3',
  routes: [
    {
      id: 'app:/',
      pathname: '/',
      regex: routePatternToRegex('/'),
      kind: 'app-page',
      classification: 'static',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: [], css: [], fonts: [] },
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
      id: 'route:/api/jobs/digest',
      pathname: '/api/jobs/digest',
      regex: routePatternToRegex('/api/jobs/digest'),
      kind: 'app-route',
      classification: 'route',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
});

const SECRET = 'internal-secret-0123456789-abcdefghijklmnop';

/** A stand-in for `.open-next/worker.js` that renders tiny documents and records what it received. */
function fakeNext(render?: (request: Request) => Response | Promise<Response>) {
  const received: Request[] = [];
  const contexts: Array<ReturnType<typeof getCurrentContext>> = [];
  const mod: NextWorkerModule = {
    default: {
      async fetch(request) {
        received.push(request);
        contexts.push(getCurrentContext());
        if (render) return render(request);
        const path = new URL(request.url).pathname;
        if (path.startsWith('/api/')) return Response.json({ ok: true, path });
        return new Response(`<!doctype html><html><head></head><body><h1>${path}</h1></body></html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
  };
  const loader = vi.fn(async () => mod);
  return { loader, received, contexts };
}

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://shop.example.com${path}`, {
    ...init,
    headers: {
      host: 'shop.example.com',
      accept: 'text/html',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      'accept-language': 'en-US,en;q=0.9',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

describe('createWorker fetch', () => {
  it('runs the pipeline around Next.js and forwards context headers', async () => {
    const next = fakeNext();
    const worker = createWorker({
      config: { site: { name: 'shop' } },
      next: next.loader,
      manifest: async () => ({ default: manifest }),
      development: false,
    });
    const exec = createFakeExecutionContext();
    const response = await worker.fetch(request('/account'), {}, exec);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>/account</h1>');
    const forwarded = next.received[0]!.headers;
    expect(forwarded.get('x-hypdriv-runner')).toBe('worker');
    expect(forwarded.get('x-hypdriv-route')).toBe('app:/account');
    expect(forwarded.get('x-hypdriv-pathname')).toBe('/account');
    const requestId = forwarded.get('x-hypdriv-request-id');
    expect(requestId).toBeTruthy();
    expect(response.headers.get('x-hypdriv-request-id')).toBe(requestId);
    expect(response.headers.get('server-timing')).toContain('next');
    // The request context is available to code running inside Next.js (hyp(), enqueue(), ...).
    expect(next.contexts[0]?.id).toBe(requestId);
    await exec.flush();
  });

  it('loads OpenNext lazily and only once', async () => {
    const next = fakeNext();
    const worker = createWorker({ config: {}, next: next.loader, manifest });
    const env = {};
    expect(next.loader).not.toHaveBeenCalled();
    await worker.fetch(request('/_hypdriv/health'), env, createFakeExecutionContext());
    expect(next.loader).not.toHaveBeenCalled();
    await worker.fetch(request('/'), env, createFakeExecutionContext());
    await worker.fetch(request('/account'), env, createFakeExecutionContext());
    expect(next.loader).toHaveBeenCalledTimes(1);
  });

  it('answers the health endpoint with build and capability information', async () => {
    const worker = createWorker({ config: { site: { name: 'shop' } }, next: fakeNext().loader, manifest });
    const response = await worker.fetch(
      request('/_hypdriv/health'),
      { HYPDRIV_KV: createFakeKV() },
      createFakeExecutionContext(),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: 'shop', build: 'build-42', next: '16.4.3', routes: 3 });
    expect(String(body.capabilities)).toContain('KV');
  });

  it('keeps development endpoints closed in production unless a token matches', async () => {
    const worker = createWorker({ config: {}, next: fakeNext().loader, manifest, development: false });
    const closed = await worker.fetch(request('/_hypdriv/dev/state'), {}, createFakeExecutionContext());
    expect(closed.status).toBe(404);
    const open = await worker.fetch(
      request('/_hypdriv/dev/state?token=t0k3n'),
      { HYPDRIV_DEVTOOLS_TOKEN: 't0k3n' },
      createFakeExecutionContext(),
    );
    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({ runner: 'worker', build: 'build-42' });
  });

  it('falls back to an empty manifest when the manifest cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const next = fakeNext();
    const worker = createWorker({
      config: {},
      next: next.loader,
      manifest: async () => {
        throw new Error('missing');
      },
    });
    const response = await worker.fetch(request('/anything'), {}, createFakeExecutionContext());
    expect(response.status).toBe(200);
    expect(next.received[0]!.headers.get('x-hypdriv-route')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('turns upstream exceptions into a JSON 500 with the request id, or a custom response', async () => {
    const failing = fakeNext(() => {
      throw new Error('render exploded');
    });
    const worker = createWorker({ config: {}, next: failing.loader, manifest, development: false });
    const response = await worker.fetch(request('/account'), {}, createFakeExecutionContext());
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toBe(response.headers.get('x-hypdriv-request-id'));
    expect(body.message).toBeUndefined();

    const custom = createWorker({
      config: {},
      next: failing.loader,
      manifest,
      onError: (error) => new Response(`custom: ${error.message}`, { status: 502 }),
    });
    const r2 = await custom.fetch(request('/account'), {}, createFakeExecutionContext());
    expect(r2.status).toBe(502);
    expect(await r2.text()).toBe('custom: render exploded');
  });

  it('lets callers customise the stage list', async () => {
    const next = fakeNext();
    const worker = createWorker({
      config: {},
      next: next.loader,
      manifest,
      stages: (defaults) => [
        ...defaults,
        {
          name: 'stamp',
          post: (_ctx, response) => {
            const headers = new Headers(response.headers);
            headers.set('x-stamp', '1');
            return new Response(response.body, { status: response.status, headers });
          },
        },
      ],
    });
    const response = await worker.fetch(request('/'), {}, createFakeExecutionContext());
    expect(response.headers.get('x-stamp')).toBe('1');
  });
});

describe('createWorker hardening', () => {
  it('never forwards client-supplied HypDriv, nonce or middleware headers to Next.js', async () => {
    const next = fakeNext();
    const worker = createWorker({ config: {}, next: next.loader, manifest });
    await worker.fetch(
      request('/account', {
        headers: {
          'x-hypdriv-flags': '{"admin":true}',
          'x-hypdriv-runner': 'proxy',
          'x-nonce': 'attacker',
          'x-middleware-subrequest': 'middleware:middleware:middleware',
        },
      }),
      {},
      createFakeExecutionContext(),
    );
    const forwarded = next.received[0]!.headers;
    expect(forwarded.get('x-hypdriv-runner')).toBe('worker');
    expect(forwarded.get('x-middleware-subrequest')).toBeNull();
    expect(forwarded.get('x-nonce')).not.toBe('attacker');
    expect(forwarded.get('x-hypdriv-flags')).toBeNull();
  });
});

describe('createWorker ISR revalidation (OpenNext queue)', () => {
  const TOKEN = '91a68bb5351b898134e48c088de025b9';
  const setup = async () => {
    let version = 1;
    let revalidating = false;
    const next = fakeNext((req) => {
      const path = new URL(req.url).pathname;
      revalidating = req.headers.get('x-prerender-revalidate') === TOKEN;
      return new Response(
        req.method === 'HEAD'
          ? null
          : `<!doctype html><html><head></head><body><h1>${path} v${version}</h1></body></html>`,
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            ...(revalidating ? { 'x-nextjs-cache': 'REVALIDATED' } : {}),
          },
        },
      );
    });
    const worker = createWorker({
      config: {
        site: { name: 'shop' },
        cache: { edge: { store: 'kv', policies: [{ id: 'home', match: '/', ttl: 3600 }] } },
        security: { rateLimit: [{ id: 'all', match: '/**', limit: 3, window: '1m' }] },
      },
      next: next.loader,
      manifest: async () => ({
        default: { ...manifest, revalidation: { tokenHash: await sha256Hex(TOKEN) } },
      }),
      development: false,
    });
    const env = { HYPDRIV_KV: createFakeKV() };
    const get = async (ip = '203.0.113.1') => {
      const exec = createFakeExecutionContext();
      const response = await worker.fetch(request('/', { headers: { 'cf-connecting-ip': ip } }), env, exec);
      const body = await response.text();
      // The KV tag index merges writes per second (KV allows one write per key per second).
      await exec.flush();
      return { response, body };
    };
    return {
      next,
      worker,
      env,
      get,
      bump: () => {
        version++;
      },
    };
  };

  it('sends verified revalidation requests straight to Next.js and drops the stale edge copies', async () => {
    const t = await setup();
    const first = await t.get();
    expect(first.response.headers.get('x-hypdriv-cache')).toBe('MISS');
    t.bump();
    const second = await t.get();
    expect(second.body).toContain('v1');
    expect(second.response.headers.get('x-hypdriv-cache')).toBe('HIT');
    await t.get();
    // The rate limit (3/min) is exhausted for this client; revalidation must not be subject to it.
    expect((await t.get()).response.status).toBe(429);
    const calls = t.next.received.length;

    // OpenNext's DOQueueHandler: HEAD, no browser headers, the build's preview-mode id.
    const exec = createFakeExecutionContext();
    const revalidation = await t.worker.fetch(
      new Request('https://shop.example.com/', {
        method: 'HEAD',
        headers: { 'x-prerender-revalidate': TOKEN, 'x-isr': '1' },
      }),
      t.env,
      exec,
    );
    await exec.flush();
    expect(revalidation.status).toBe(200);
    expect(revalidation.headers.get('x-nextjs-cache')).toBe('REVALIDATED');
    expect(t.next.received.length).toBe(calls + 1);
    const forwarded = t.next.received.at(-1)!;
    expect(forwarded.method).toBe('HEAD');
    expect(forwarded.headers.get('x-prerender-revalidate')).toBe(TOKEN);
    // proxy.ts inside OpenNext sees the Worker's context and passes through.
    expect(t.next.contexts.at(-1)?.runner).toBe('worker');

    const after = await t.get('198.51.100.7');
    expect(after.response.headers.get('x-hypdriv-cache')).toBe('MISS');
    expect(after.body).toContain('v2');
  });

  it('runs requests with a wrong or oversized token through the Drivetrain', async () => {
    const t = await setup();
    await t.get();
    for (const token of ['not-the-token', TOKEN.toUpperCase(), 'x'.repeat(300)]) {
      const calls = t.next.received.length;
      const exec = createFakeExecutionContext();
      const response = await t.worker.fetch(
        request('/', { headers: { 'x-prerender-revalidate': token } }),
        t.env,
        exec,
      );
      await response.text();
      await exec.flush();
      expect(response.headers.get('x-hypdriv-cache')).toBe('HIT');
      expect(t.next.received.length).toBe(calls);
    }
  });

  it('ignores the header when the manifest has no revalidation hash', async () => {
    const next = fakeNext();
    const worker = createWorker({
      config: { site: { name: 'shop' } },
      next: next.loader,
      manifest: async () => ({ default: manifest }),
      development: false,
    });
    const exec = createFakeExecutionContext();
    await worker.fetch(request('/', { headers: { 'x-prerender-revalidate': TOKEN } }), {}, exec);
    await exec.flush();
    expect(next.received[0]!.headers.get('x-hypdriv-runner')).toBe('worker');
    expect(next.received[0]!.headers.get('x-hypdriv-route')).toBe('app:/');
  });
});

describe('createWorker scheduled/queue/email', () => {
  const config = {
    site: { origin: 'https://shop.example.com' },
    jobs: {
      cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } },
      queues: { emails: { path: '/api/jobs/digest' } },
    },
  };

  it('dispatches cron triggers through the worker itself (signed)', async () => {
    const next = fakeNext();
    const worker = createWorker({ config, next: next.loader, manifest });
    await worker.scheduled(
      { cron: '0 9 * * 1', scheduledTime: 0 },
      { HYPDRIV_INTERNAL_SECRET: SECRET },
      createFakeExecutionContext(),
    );
    const job = next.received.find((r) => new URL(r.url).pathname === '/api/jobs/digest');
    expect(job).toBeDefined();
    expect(await signing.verifyInternalRequest(job!.clone() as Request, SECRET)).toBe(true);
  });

  it('uses WORKER_SELF_REFERENCE when bound', async () => {
    const self = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const worker = createWorker({ config, next: fakeNext().loader, manifest });
    await worker.scheduled(
      { cron: '0 9 * * 1', scheduledTime: 0 },
      { HYPDRIV_INTERNAL_SECRET: SECRET, WORKER_SELF_REFERENCE: self },
      createFakeExecutionContext(),
    );
    expect(self.fetch).toHaveBeenCalledTimes(1);
  });

  it('acks queue batches the consumer accepted', async () => {
    const worker = createWorker({ config, next: fakeNext().loader, manifest });
    const acked: string[] = [];
    await worker.queue(
      {
        queue: 'emails',
        messages: [
          {
            id: 'm1',
            timestamp: new Date(),
            body: { to: 'a@example.com' },
            attempts: 1,
            ack: () => void acked.push('m1'),
            retry: () => {},
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      },
      { HYPDRIV_INTERNAL_SECRET: SECRET },
      createFakeExecutionContext(),
    );
    expect(acked).toEqual(['m1']);
  });
});

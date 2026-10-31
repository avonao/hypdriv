import { type QueueLike, queueEnvKey, registerRuntime, resolveConfig } from '@hypdriv/core';
import { signing } from '@hypdriv/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enqueue } from './jobs';

const SECRET = 'internal-secret-0123456789-abcdefghijklmnop';

function recordingQueue(ready?: () => boolean) {
  const sent: Array<{ body: unknown; options: unknown }> = [];
  const queue: QueueLike = {
    async send(body, options) {
      sent.push({ body, options });
    },
    ...(ready ? { ready } : {}),
  };
  return { queue, sent };
}

const config = resolveConfig({
  site: { origin: 'https://shop.example.com' },
  cloudflare: { bindings: { queues: { emails: 'EMAIL_QUEUE' } } },
  jobs: { queues: { emails: { path: '/api/jobs/emails' }, reports: { path: '/api/jobs/reports' } } },
});

afterEach(() => {
  registerRuntime(null);
  vi.unstubAllGlobals();
});

describe('enqueue', () => {
  it('sends through the Cloudflare binding first', async () => {
    const binding = recordingQueue();
    const platform = recordingQueue();
    const result = await enqueue(
      'emails',
      { to: 'a@example.com' },
      {
        config,
        env: { EMAIL_QUEUE: binding.queue, [queueEnvKey('emails')]: platform.queue },
        delaySeconds: 30,
      },
    );
    expect(result).toEqual({ transport: 'queue', queue: 'emails' });
    expect(binding.sent).toEqual([{ body: { to: 'a@example.com' }, options: { delaySeconds: 30 } }]);
    expect(platform.sent).toEqual([]);
  });

  it('uses a ready platform producer (Vercel Queues) when there is no binding', async () => {
    const platform = recordingQueue(() => true);
    const result = await enqueue(
      'reports',
      { id: 1 },
      { config, env: { [queueEnvKey('reports')]: platform.queue } },
    );
    expect(result.transport).toBe('queue');
    expect(platform.sent).toHaveLength(1);
  });

  it('falls back to a signed inline consumer call when the producer is not ready', async () => {
    const platform = recordingQueue(() => false);
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const result = await enqueue(
      'reports',
      { id: 2 },
      {
        config,
        env: {
          [queueEnvKey('reports')]: platform.queue,
          HYPDRIV_INTERNAL_SECRET: SECRET,
          VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-1',
        },
      },
    );
    expect(result).toEqual({ transport: 'inline', queue: 'reports' });
    expect(platform.sent).toEqual([]);
    const request = fetch.mock.calls[0]![0];
    expect(request.url).toBe('https://shop.example.com/api/jobs/reports');
    expect(request.headers.get('x-hypdriv-job')).toBe('reports');
    expect(request.headers.get('x-vercel-protection-bypass')).toBe('bypass-1');
    expect(await signing.verifyInternalRequest(request, SECRET)).toBe(true);
    const body = (await request.json()) as { job: string; messages: Array<{ body: unknown }> };
    expect(body.job).toBe('reports');
    expect(body.messages[0]!.body).toEqual({ id: 2 });
  });

  it('does not wait on the consumer response body (a teed body never finishes cancelling)', async () => {
    const platform = recordingQueue(() => false);
    const stuck = new ReadableStream({
      pull: () => undefined,
      cancel: () => new Promise<void>(() => undefined),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stuck, { status: 200 })),
    );
    const result = await Promise.race([
      enqueue(
        'reports',
        { id: 4 },
        { config, env: { [queueEnvKey('reports')]: platform.queue, HYPDRIV_INTERNAL_SECRET: SECRET } },
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(result).toEqual({ transport: 'inline', queue: 'reports' });
  });

  it('reads config and env from the registered runtime outside a request context', async () => {
    const platform = recordingQueue();
    registerRuntime({ config, env: { [queueEnvKey('reports')]: platform.queue }, target: 'vercel' });
    await enqueue('reports', { id: 3 });
    expect(platform.sent).toHaveLength(1);
  });

  it('derives the inline origin from VERCEL_URL and reports consumer failures', async () => {
    const bare = resolveConfig({ jobs: { queues: { reports: { path: '/api/jobs/reports' } } } });
    const fetch = vi.fn(async (_request: Request) => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      enqueue('reports', {}, { config: bare, env: { VERCEL_URL: 'shop-abc.vercel.app' } }),
    ).rejects.toMatchObject({ code: 'E_UPSTREAM' });
    expect(fetch.mock.calls[0]![0].url).toBe('https://shop-abc.vercel.app/api/jobs/reports');
  });

  it('explains what is missing', async () => {
    await expect(enqueue('reports', {})).rejects.toMatchObject({ code: 'E_INTERNAL' });
    await expect(enqueue('unknown', {}, { config, env: {} })).rejects.toMatchObject({ code: 'E_CONFIG' });
    const bare = resolveConfig({ jobs: { queues: { reports: { path: '/api/jobs/reports' } } } });
    await expect(enqueue('reports', {}, { config: bare, env: {} })).rejects.toThrow(/site\.origin/);
  });
});

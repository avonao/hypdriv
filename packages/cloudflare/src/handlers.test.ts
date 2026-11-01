import { type Logger, loadConfig, queueConsumerFor, type ResolvedConfig, silentLogger } from '@hypdriv/core';
import { signing } from '@hypdriv/security';
import { describe, expect, it, vi } from 'vitest';
import {
  type DispatchContext,
  dispatchEmail,
  dispatchQueue,
  dispatchScheduled,
  type EmailMessageLike,
  forwardTail,
  type MessageBatchLike,
  type QueueMessageLike,
  type TailEventLike,
} from './handlers';

const SECRET = 'internal-secret-0123456789-abcdefghijklmnop';

function recordingLogger() {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const make = (): Logger => ({
    level: 'debug',
    debug: (message, fields) => lines.push({ level: 'debug', message, ...(fields ? { fields } : {}) }),
    info: (message, fields) => lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => lines.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
    child: () => make(),
  });
  return { log: make(), lines };
}

function dispatchContext(
  config: ResolvedConfig,
  invoke: DispatchContext['invoke'],
  env: Record<string, unknown> = { HYPDRIV_INTERNAL_SECRET: SECRET },
  log: Logger = silentLogger,
): DispatchContext {
  return { config, env, log, invoke, waitUntil: () => {} };
}

describe('dispatchScheduled', () => {
  const config = loadConfig({
    site: { origin: 'https://shop.example.com' },
    jobs: {
      cron: {
        digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' },
        cleanup: { cron: '*/15 * * * *', path: '/api/jobs/cleanup', method: 'GET' },
      },
    },
    cache: { warm: { cron: '*/15 * * * *', routes: ['/', '/pricing'], concurrency: 2 } },
  });

  it('posts signed requests to the job routes that match the cron expression', async () => {
    const requests: Request[] = [];
    const invoke = vi.fn(async (request: Request) => {
      requests.push(request.clone() as Request);
      return Response.json({ ok: true });
    });
    const result = await dispatchScheduled(
      { cron: '0  9 * * 1', scheduledTime: 1_793_000_000_000 },
      dispatchContext(config, invoke),
    );
    expect(result).toEqual({ ran: ['digest'], failed: [] });
    const request = requests[0]!;
    expect(new URL(request.url).toString()).toBe('https://shop.example.com/api/jobs/digest');
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-hypdriv-job')).toBe('digest');
    expect(await signing.verifyInternalRequest(request.clone() as Request, SECRET)).toBe(true);
    expect(await request.json()).toEqual({
      job: 'digest',
      cron: '0 9 * * 1',
      scheduledTime: 1_793_000_000_000,
    });
  });

  it('runs GET jobs and warms configured routes on the shared schedule', async () => {
    const urls: string[] = [];
    const invoke = vi.fn(async (request: Request) => {
      urls.push(
        `${request.method} ${new URL(request.url).pathname}${request.headers.get('x-hypdriv-warm') ? ' (warm)' : ''}`,
      );
      return new Response('ok');
    });
    const result = await dispatchScheduled(
      { cron: '*/15 * * * *', scheduledTime: Date.now() },
      dispatchContext(config, invoke),
    );
    expect(result.ran).toEqual(['cleanup', 'warm']);
    expect(urls).toContain('GET /api/jobs/cleanup');
    expect(urls).toContain('GET / (warm)');
    expect(urls).toContain('GET /pricing (warm)');
  });

  describe('hot warming', () => {
    const hotConfig = loadConfig({
      site: { origin: 'https://shop.example.com' },
      cache: {
        warm: { cron: '*/30 * * * *', routes: ['/'], concurrency: 2, hot: { limit: 3, minViews: 20 } },
      },
    });
    const creds = {
      HYPDRIV_INTERNAL_SECRET: SECRET,
      HYPDRIV_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32),
      HYPDRIV_ANALYTICS_API_TOKEN: 'token',
      HYPDRIV_ANALYTICS_DATASET: 'shop_vitals',
    };
    const rows = (data: Array<Record<string, unknown>>) =>
      vi.fn(async () => Response.json({ meta: [], data, rows: data.length }));

    it('adds the busiest cacheable pages to the configured routes', async () => {
      const warmed: string[] = [];
      const fetchSpy = rows([
        { pathname: '/blog/hello', views: 900 },
        { pathname: '/', views: 800 },
        { pathname: '/account', views: 700 },
        { pathname: '/pricing', views: 600 },
        { pathname: '/rare', views: 5 },
      ]);
      const result = await dispatchScheduled(
        { cron: '*/30 * * * *', scheduledTime: 0 },
        {
          ...dispatchContext(
            hotConfig,
            async (request) => {
              warmed.push(new URL(request.url).pathname);
              return new Response('ok');
            },
            creds,
          ),
          fetch: fetchSpy as never,
          cacheable: (path) => path !== '/account',
        },
      );
      expect(result.ran).toEqual(['warm']);
      expect(warmed.sort()).toEqual(['/', '/blog/hello', '/pricing']);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/analytics_engine/sql`,
      );
      expect(String(init.body)).toContain("blob1 = 'TTFB'");
      expect(String(init.body)).toContain('FROM shop_vitals');
    });

    it('never requests a path outside the site, whatever the beacons claimed', async () => {
      const warmed: string[] = [];
      await dispatchScheduled(
        { cron: '*/30 * * * *', scheduledTime: 0 },
        {
          ...dispatchContext(
            hotConfig,
            async (request) => {
              warmed.push(request.url);
              return new Response('ok');
            },
            creds,
          ),
          fetch: rows([
            { pathname: '//evil.example/x', views: 999 },
            { pathname: 'https://evil.example/', views: 998 },
            { pathname: '/a/../secret', views: 997 },
            { pathname: '/_hypdriv/purge', views: 996 },
            { pathname: '/ok', views: 50 },
          ]) as never,
        },
      );
      expect(warmed.sort()).toEqual(['https://shop.example.com/', 'https://shop.example.com/ok']);
    });

    it('still warms the configured routes when the query fails or credentials are missing', async () => {
      for (const [env, fetchImpl, expected] of [
        [creds, vi.fn(async () => new Response('nope', { status: 403 })), 'query failed'],
        [{ HYPDRIV_INTERNAL_SECRET: SECRET }, vi.fn(), 'missing'],
      ] as const) {
        const { log, lines } = recordingLogger();
        const warmed: string[] = [];
        const result = await dispatchScheduled(
          { cron: '*/30 * * * *', scheduledTime: 0 },
          {
            ...dispatchContext(
              hotConfig,
              async (request) => {
                warmed.push(new URL(request.url).pathname);
                return new Response('ok');
              },
              env,
              log,
            ),
            fetch: fetchImpl as never,
          },
        );
        expect(result.ran).toEqual(['warm']);
        expect(warmed).toEqual(['/']);
        expect(lines.find((l) => l.level === 'warn')?.message).toContain(
          expected === 'missing' ? 'settings are missing' : 'query failed',
        );
        if (expected === 'missing') expect(fetchImpl).not.toHaveBeenCalled();
      }
    });

    it('does nothing for hot pages when warm.hot is off', async () => {
      const fetchSpy = vi.fn();
      const warmed: string[] = [];
      await dispatchScheduled(
        { cron: '*/15 * * * *', scheduledTime: 0 },
        {
          ...dispatchContext(
            config,
            async (request) => {
              warmed.push(new URL(request.url).pathname);
              return new Response('ok');
            },
            creds,
          ),
          fetch: fetchSpy as never,
        },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(warmed).toContain('/pricing');
    });
  });

  it('reports failing jobs and rethrows so Cloudflare records the failure', async () => {
    const { log, lines } = recordingLogger();
    const invoke = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      dispatchScheduled(
        { cron: '0 9 * * 1', scheduledTime: 0 },
        dispatchContext(config, invoke, undefined, log),
      ),
    ).rejects.toThrow(/1 cron job\(s\) failed: digest/);
    expect(lines.some((l) => l.level === 'error' && l.message === 'cron job failed')).toBe(true);
  });

  it('warns about triggers without a configured job and sends unsigned requests without a secret', async () => {
    const { log, lines } = recordingLogger();
    const invoke = vi.fn(async () => new Response('ok'));
    await dispatchScheduled(
      { cron: '0 0 1 1 *', scheduledTime: 0 },
      dispatchContext(config, invoke, {}, log),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(lines.some((l) => l.message === 'cron trigger has no configured job')).toBe(true);

    const requests: Request[] = [];
    await dispatchScheduled(
      { cron: '0 9 * * 1', scheduledTime: 0 },
      dispatchContext(
        config,
        async (r) => {
          requests.push(r);
          return new Response('ok');
        },
        {},
        log,
      ),
    );
    expect(requests[0]!.headers.get('x-hypdriv-signature')).toBeNull();
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('HYPDRIV_INTERNAL_SECRET'))).toBe(true);
  });
});

function batchOf(queue: string, bodies: unknown[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages: QueueMessageLike[] = bodies.map((body, i) => ({
    id: `m${i + 1}`,
    timestamp: new Date('2026-10-30T00:00:00.000Z'),
    body,
    attempts: 1,
    ack: () => void acked.push(`m${i + 1}`),
    retry: () => void retried.push(`m${i + 1}`),
  }));
  const batch: MessageBatchLike = {
    queue,
    messages,
    ackAll: () => void acked.push(...messages.map((m) => m.id)),
    retryAll: () => void retried.push(...messages.map((m) => m.id)),
  };
  return { batch, acked, retried };
}

describe('dispatchQueue', () => {
  const config = loadConfig({
    jobs: {
      queues: { emails: { path: '/api/queues/emails' }, audit: { path: '/api/queues/audit', retry: 'none' } },
    },
  });

  it('acks everything the consumer accepted and retries what it asks for', async () => {
    const seen: unknown[] = [];
    const invoke = vi.fn(async (request: Request) => {
      seen.push(await request.json());
      return Response.json({ ok: true, result: { retry: ['m2'] } });
    });
    const { batch, acked, retried } = batchOf('emails', [{ to: 'a@example.com' }, { to: 'b@example.com' }]);
    await dispatchQueue(batch, dispatchContext(config, invoke));
    expect(acked).toEqual(['m1']);
    expect(retried).toEqual(['m2']);
    expect(seen[0]).toEqual({
      job: 'emails',
      queue: 'emails',
      messages: [
        { id: 'm1', timestamp: '2026-10-30T00:00:00.000Z', body: { to: 'a@example.com' }, attempts: 1 },
        { id: 'm2', timestamp: '2026-10-30T00:00:00.000Z', body: { to: 'b@example.com' }, attempts: 1 },
      ],
    });
  });

  it('retries the whole batch when the consumer fails, unless retries are disabled', async () => {
    const failing = vi.fn(async () => new Response('down', { status: 503 }));
    const a = batchOf('emails', [1, 2]);
    await dispatchQueue(a.batch, dispatchContext(config, failing));
    expect(a.retried).toEqual(['m1', 'm2']);

    const b = batchOf('audit', [1]);
    await dispatchQueue(b.batch, dispatchContext(config, failing));
    expect(b.acked).toEqual(['m1']);
    expect(b.retried).toEqual([]);
  });

  it('maps per-environment queue names to the job (exact names before wildcards)', async () => {
    const envConfig = loadConfig({
      jobs: {
        queues: {
          jobs: { path: '/api/jobs/work', queues: ['*-jobs'] },
          dead: { path: '/api/jobs/dead', queues: ['shop-jobs-dlq', 'shop-staging-jobs-dlq'] },
          billing: { path: '/api/jobs/billing', queues: ['shop-billing'] },
        },
      },
    });
    const paths: string[] = [];
    const bodies: Array<{ job: string; queue: string }> = [];
    const invoke = vi.fn(async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      bodies.push((await request.json()) as { job: string; queue: string });
      return Response.json({ ok: true });
    });
    for (const queue of ['shop-staging-jobs', 'shop-jobs', 'shop-jobs-dlq', 'shop-billing'])
      await dispatchQueue(batchOf(queue, [1]).batch, dispatchContext(envConfig, invoke));
    expect(paths).toEqual(['/api/jobs/work', '/api/jobs/work', '/api/jobs/dead', '/api/jobs/billing']);
    expect(bodies.map((b) => `${b.job}<-${b.queue}`)).toEqual([
      'jobs<-shop-staging-jobs',
      'jobs<-shop-jobs',
      'dead<-shop-jobs-dlq',
      'billing<-shop-billing',
    ]);
    expect(queueConsumerFor(envConfig, 'shop-jobs-dlq-extra')).toBeNull();
    expect(envConfig.jobs.queues.billing?.queues).toEqual(['shop-billing']);
    expect(loadConfig({ jobs: { queues: { a: { path: '/a' } } } }).jobs.queues.a?.queues).toEqual(['a']);
  });

  it('retries batches for queues without a consumer', async () => {
    const { batch, retried } = batchOf('unknown', [1]);
    await dispatchQueue(batch, dispatchContext(config, vi.fn()));
    expect(retried).toEqual(['m1']);
  });
});

function email(raw: string, rejects: string[]): EmailMessageLike {
  return {
    from: 'sender@example.com',
    to: 'support@shop.example.com',
    headers: new Headers({ 'message-id': '<abc@example.com>' }),
    raw: new Response(raw).body!,
    rawSize: raw.length,
    setReject: (reason) => void rejects.push(reason),
    forward: async () => {},
  };
}

describe('dispatchEmail', () => {
  it('posts the raw MIME message to the configured route', async () => {
    const config = loadConfig({ jobs: { email: { path: '/api/inbound-email' } } });
    const requests: Request[] = [];
    const rejects: string[] = [];
    await dispatchEmail(
      email('Subject: hi\r\n\r\nbody', rejects),
      dispatchContext(config, async (r) => {
        requests.push(r);
        return new Response(null, { status: 204 });
      }),
    );
    const request = requests[0]!;
    expect(new URL(request.url).pathname).toBe('/api/inbound-email');
    expect(request.headers.get('content-type')).toBe('message/rfc822');
    expect(request.headers.get('x-email-from')).toBe('sender@example.com');
    expect(request.headers.get('x-email-message-id')).toBe('<abc@example.com>');
    expect(await signing.verifyInternalRequest(request.clone() as Request, SECRET)).toBe(true);
    expect(await request.text()).toBe('Subject: hi\r\n\r\nbody');
    expect(rejects).toEqual([]);
  });

  it('rejects mail the handler refuses and mail without a handler', async () => {
    const config = loadConfig({ jobs: { email: { path: '/api/inbound-email' } } });
    const rejects: string[] = [];
    await dispatchEmail(
      email('x', rejects),
      dispatchContext(config, async () => new Response('mailbox unavailable', { status: 550 })),
    );
    expect(rejects).toEqual(['mailbox unavailable']);

    const none: string[] = [];
    await dispatchEmail(email('x', none), dispatchContext(loadConfig({}), vi.fn()));
    expect(none).toEqual(['no email handler configured']);
  });
});

describe('forwardTail', () => {
  it('logs exceptions and warn/error console lines', () => {
    const { log, lines } = recordingLogger();
    forwardTail(
      [
        {
          scriptName: 'shop',
          outcome: 'exception',
          eventTimestamp: 1,
          event: null,
          logs: [
            { level: 'log', message: ['hello'], timestamp: 1 },
            { level: 'warn', message: ['careful'], timestamp: 2 },
            { level: 'error', message: ['bad'], timestamp: 3 },
          ],
          exceptions: [{ name: 'TypeError', message: 'x is undefined', timestamp: 4 }],
        },
      ],
      { log },
    );
    expect(lines.map((l) => `${l.level}:${l.message}`)).toEqual([
      'error:tail exception',
      'warn:tail log',
      'error:tail log',
    ]);
  });

  it('reports invocations that hit a limit or were cancelled without an exception', () => {
    const { log, lines } = recordingLogger();
    const event = (outcome: string, extra: Partial<TailEventLike> = {}): TailEventLike => ({
      scriptName: 'shop',
      outcome,
      eventTimestamp: 1,
      event: { request: { url: 'https://shop.example.com/heavy?x=1', method: 'GET' } },
      logs: [],
      exceptions: [],
      ...extra,
    });
    forwardTail(
      [
        event('ok'),
        event('exceededCpu'),
        event('canceled', { event: { cron: '* * * * *' } }),
        event('exception', { exceptions: [{ name: 'Error', message: 'boom', timestamp: 2 }] }),
      ],
      { log },
    );
    expect(lines.map((l) => `${l.level}:${l.message}`)).toEqual([
      'error:tail outcome',
      'error:tail outcome',
      'error:tail exception',
    ]);
    expect(lines[0]!.fields).toMatchObject({
      outcome: 'exceededCpu',
      path: '/heavy',
      host: 'shop.example.com',
      method: 'GET',
    });
    expect(lines[1]!.fields).toMatchObject({ outcome: 'canceled', cron: '* * * * *' });
  });
});

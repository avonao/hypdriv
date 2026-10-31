import { type HypDrivEnv, type Logger, queueConsumerFor, type ResolvedConfig, readEnv } from '@hypdriv/core';
import { signing } from '@hypdriv/security';

export type Invoke = (request: Request) => Promise<Response>;

export interface DispatchContext {
  config: ResolvedConfig;
  env: HypDrivEnv;
  log: Logger;
  invoke: Invoke;
  waitUntil(promise: Promise<unknown>): void;
}

function originFor(config: ResolvedConfig): string {
  return config.site.origin ?? 'https://hypdriv.internal';
}

async function internalRequest(
  ctx: DispatchContext,
  path: string,
  body: unknown,
  init: { method?: string; headers?: Record<string, string>; job?: string } = {},
): Promise<Request> {
  const url = new URL(path, originFor(ctx.config));
  const headers = new Headers({
    'content-type': 'application/json',
    'x-hypdriv-internal': '1',
    ...(init.headers ?? {}),
  });
  if (init.job) headers.set('x-hypdriv-job', init.job);
  const request = new Request(url, {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : JSON.stringify(body),
  });
  const secret = readEnv(ctx.env, ctx.config.security.internalAuth.secretEnv);
  if (!secret) {
    ctx.log.warn(
      `hypdriv: ${ctx.config.security.internalAuth.secretEnv} is not set; internal requests are unsigned and job routes will reject them outside development`,
    );
    return request;
  }
  return signing.signInternalRequest(request, secret);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
  noRetry?(): void;
}

/** Dispatches a cron trigger to the configured job routes (and warms routes when `cache.warm.cron` matches). */
const normalizeCron = (value: string) => value.trim().replace(/\s+/g, ' ');

export async function dispatchScheduled(
  event: ScheduledEventLike,
  ctx: DispatchContext,
): Promise<{ ran: string[]; failed: string[] }> {
  const cron = normalizeCron(event.cron);
  const ran: string[] = [];
  const failed: string[] = [];
  const jobs = Object.entries(ctx.config.jobs.cron).filter(([, j]) => normalizeCron(j.cron) === cron);
  for (const [name, job] of jobs) {
    try {
      const request = await internalRequest(
        ctx,
        job.path,
        { job: name, cron, scheduledTime: event.scheduledTime },
        { method: job.method, job: name },
      );
      const res = await withTimeout(ctx.invoke(request), job.timeoutMs, `job ${name}`);
      if (!res.ok) throw new Error(`job ${name} responded ${res.status}`);
      ran.push(name);
      ctx.log.info('cron job completed', { job: name, cron, status: res.status });
    } catch (err) {
      failed.push(name);
      ctx.log.error('cron job failed', { job: name, cron, error: (err as Error).message });
    }
  }
  const warm = ctx.config.cache.warm;
  const warmMatches = !!warm.cron && normalizeCron(warm.cron) === cron;
  if (warmMatches && warm.routes.length) {
    const origin = originFor(ctx.config);
    let index = 0;
    const workers = Array.from({ length: Math.min(warm.concurrency, warm.routes.length) }, async () => {
      while (index < warm.routes.length) {
        const route = warm.routes[index++]!;
        try {
          const res = await ctx.invoke(
            new Request(new URL(route, origin), { headers: { 'x-hypdriv-warm': '1', accept: 'text/html' } }),
          );
          // Released, not awaited: a cancel on a teed body only settles once every branch is consumed.
          void res.body?.cancel().catch(() => undefined);
        } catch (err) {
          ctx.log.warn('warm failed', { route, error: (err as Error).message });
        }
      }
    });
    await Promise.all(workers);
    ran.push('warm');
  }
  if (!jobs.length && !warmMatches) ctx.log.warn('cron trigger has no configured job', { cron });
  if (failed.length) throw new Error(`hypdriv: ${failed.length} cron job(s) failed: ${failed.join(', ')}`);
  return { ran, failed };
}

export interface QueueMessageLike<Body = unknown> {
  id: string;
  timestamp: Date;
  body: Body;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike<Body = unknown> {
  queue: string;
  messages: ReadonlyArray<QueueMessageLike<Body>>;
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

/** Dispatches a queue batch to its consumer route; the route decides which messages to retry. */
export async function dispatchQueue(batch: MessageBatchLike, ctx: DispatchContext): Promise<void> {
  const resolved = queueConsumerFor(ctx.config, batch.queue);
  if (!resolved) {
    ctx.log.error('queue batch has no configured consumer', {
      queue: batch.queue,
      size: batch.messages.length,
    });
    batch.retryAll();
    return;
  }
  const { name: job, consumer } = resolved;
  const payload = {
    job,
    queue: batch.queue,
    messages: batch.messages.map((m) => ({
      id: m.id,
      timestamp: m.timestamp.toISOString(),
      body: m.body,
      attempts: m.attempts,
    })),
  };
  try {
    const request = await internalRequest(ctx, consumer.path, payload, { job });
    const res = await ctx.invoke(request);
    if (!res.ok) throw new Error(`consumer responded ${res.status}`);
    let retry = new Set<string>();
    try {
      const data = (await res.json()) as { retry?: string[]; result?: { retry?: string[] } };
      retry = new Set(data.retry ?? data.result?.retry ?? []);
    } catch {
      // no JSON body: everything acked
    }
    for (const m of batch.messages) {
      if (retry.has(m.id) && consumer.retry !== 'none') m.retry();
      else m.ack();
    }
    ctx.log.info('queue batch processed', {
      job,
      queue: batch.queue,
      size: batch.messages.length,
      retried: retry.size,
    });
  } catch (err) {
    ctx.log.error('queue batch failed', { job, queue: batch.queue, error: (err as Error).message });
    if (consumer.retry === 'none') batch.ackAll();
    else batch.retryAll();
  }
}

export interface EmailMessageLike {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

/** Dispatches an inbound email to the configured route (raw MIME as the body). */
export async function dispatchEmail(message: EmailMessageLike, ctx: DispatchContext): Promise<void> {
  const target = ctx.config.jobs.email;
  if (!target) {
    message.setReject('no email handler configured');
    return;
  }
  const url = new URL(target.path, originFor(ctx.config));
  const headers = new Headers({
    'content-type': 'message/rfc822',
    'x-hypdriv-internal': '1',
    'x-hypdriv-job': 'email',
    'x-email-from': message.from,
    'x-email-to': message.to,
  });
  const id = message.headers.get('message-id');
  if (id) headers.set('x-email-message-id', id);
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  let request = new Request(url, { method: 'POST', headers, body: raw });
  const secret = readEnv(ctx.env, ctx.config.security.internalAuth.secretEnv);
  if (secret) request = await signing.signInternalRequest(request, secret);
  const res = await ctx.invoke(request);
  if (res.status >= 400) {
    const reason =
      res.status === 550 || res.status === 422
        ? await res.text().catch(() => 'rejected')
        : `handler responded ${res.status}`;
    message.setReject(reason.slice(0, 200));
  }
}

export interface TailEventLike {
  scriptName?: string | null;
  outcome: string;
  eventTimestamp: number | null;
  event: unknown;
  logs: Array<{ level: string; message: unknown[]; timestamp: number }>;
  exceptions: Array<{ name: string; message: string; timestamp: number }>;
}

/** Tail outcomes that mean the invocation did not complete normally. */
const FAILED_OUTCOMES = new Set([
  'exception',
  'exceededCpu',
  'exceededMemory',
  'exceededWallTime',
  'scriptNotFound',
  'canceled',
  'responseStreamDisconnected',
  'loadSheddingError',
  'killSwitch',
  'daemonDown',
  'unknown',
]);

function eventTarget(event: unknown): Record<string, string> {
  const e = event as {
    request?: { url?: unknown; method?: unknown };
    cron?: unknown;
    queue?: unknown;
  } | null;
  const out: Record<string, string> = {};
  if (e?.request && typeof e.request.url === 'string') {
    try {
      const url = new URL(e.request.url);
      out.path = url.pathname;
      out.host = url.host;
    } catch {
      // not a URL
    }
    if (typeof e.request.method === 'string') out.method = e.request.method;
  }
  if (typeof e?.cron === 'string') out.cron = e.cron;
  if (typeof e?.queue === 'string') out.queue = e.queue;
  return out;
}

/**
 * Forwards tail events (from a tail consumer Worker) to structured logs: exceptions, `warn`/`error`
 * console lines, and invocations that ended abnormally without an exception (CPU, memory or wall-time
 * limits, cancellations), which otherwise leave no trace in the producer's own logs.
 */
export function forwardTail(events: TailEventLike[], ctx: Pick<DispatchContext, 'log'>): void {
  for (const e of events) {
    if (FAILED_OUTCOMES.has(e.outcome) && !e.exceptions.length)
      ctx.log.error('tail outcome', { script: e.scriptName, outcome: e.outcome, ...eventTarget(e.event) });
    for (const ex of e.exceptions)
      ctx.log.error('tail exception', {
        script: e.scriptName,
        name: ex.name,
        message: ex.message,
        outcome: e.outcome,
        at: ex.timestamp,
      });
    for (const l of e.logs) {
      if (l.level === 'error')
        ctx.log.error('tail log', { script: e.scriptName, message: l.message, at: l.timestamp });
      else if (l.level === 'warn')
        ctx.log.warn('tail log', { script: e.scriptName, message: l.message, at: l.timestamp });
    }
  }
}

import { HypDrivError, json, type Logger, type QueueLike, type ResolvedConfig, toError } from '@hypdriv/core';
import {
  getVercelSdk,
  type QueueCallbackOptions,
  type QueueHandleCallbackFn,
  type QueueMessageHandler,
  type QueueSendOptions,
  type VercelSdk,
} from './sdk';
import { chunk, defaultLogger, warnOnce } from './util';

const NOT_REGISTERED =
  '@vercel/queue is not registered: call registerVercelSdk({ queue: { send, handleCallback } }) in instrumentation.ts';

function queueSdk(): NonNullable<VercelSdk['queue']> {
  const queue = getVercelSdk().queue;
  if (!queue) throw new HypDrivError('E_UNSUPPORTED', NOT_REGISTERED);
  return queue;
}

/** The Vercel Queues topic of a HypDriv queue name (`vercel.queues[name]`, else the name itself). */
export function queueTopic(name: string, config: ResolvedConfig): string {
  return config.vercel.queues[name] ?? name;
}

/**
 * A `QueueLike` producer over Vercel Queues (`send`/`sendBatch` from `@vercel/queue`, registered with
 * `registerVercelSdk`). Payloads are JSON-serialised by the SDK; `delaySeconds` maps to the SDK option of the
 * same name (`contentType` is not used). `sendBatch` uses the SDK's batch API (100 messages per request)
 * when registered and throws when any message was not accepted.
 */
export function vercelQueue<Body = unknown>(name: string, config: ResolvedConfig): QueueLike<Body> {
  const topic = queueTopic(name, config);
  const sendOptions = (delaySeconds: number | undefined): QueueSendOptions | undefined =>
    delaySeconds !== undefined && delaySeconds > 0 ? { delaySeconds: Math.floor(delaySeconds) } : undefined;
  return {
    async send(body, options) {
      await queueSdk().send(topic, body, sendOptions(options?.delaySeconds));
    },
    async sendBatch(messages) {
      const list = [...messages];
      if (!list.length) return;
      const sdk = queueSdk();
      if (!sdk.sendBatch) {
        await Promise.all(list.map((m) => sdk.send(topic, m.body, sendOptions(m.delaySeconds))));
        return;
      }
      const failures: string[] = [];
      for (const batch of chunk(list, 100)) {
        const results = await sdk.sendBatch(
          topic,
          batch.map((m) => ({ payload: m.body, ...sendOptions(m.delaySeconds) })),
        );
        for (const result of results) if (result.status === 'failed') failures.push(`${result.statusCode}: ${result.error}`);
      }
      if (failures.length)
        throw new HypDrivError('E_UPSTREAM', `Vercel Queues rejected ${failures.length} of ${list.length} messages`, {
          topic,
          errors: failures.slice(0, 10),
        });
    },
  };
}

/** One message as HypDriv queue consumers receive it (the JSON `dispatchQueue` posts on Cloudflare). */
export interface QueueJobMessage {
  id: string;
  /** ISO-8601 publish time. */
  timestamp: string;
  body: unknown;
  /** Delivery attempt, starting at 1. */
  attempts: number;
}

/** Input of a HypDriv queue consumer. */
export interface QueueJobInput {
  /** The HypDriv queue name (reverse-mapped from the Vercel topic). */
  job: string;
  messages: QueueJobMessage[];
}

/** A HypDriv queue consumer: returns the ids of messages to retry (others are acknowledged). */
export type QueueJobHandler = (input: QueueJobInput) => Promise<{ retry?: string[] } | void>;

/** Options of `queueConsumer` / `toQueueCallback`. */
export interface QueueConsumerOptions {
  /** Message lock duration while the handler runs (SDK default 300, max 3600). */
  visibilityTimeoutSeconds?: number;
  /** Reverse-maps topics to HypDriv queue names (`vercel.queues`) and supplies `jobs.queues[name].retry`. */
  config?: ResolvedConfig;
  /** Fixed job name (overrides the topic mapping). */
  job?: string;
  /** Delay before a requested retry, by delivery attempt (default 5 s doubling up to 15 min). */
  retryDelaySeconds?: (attempts: number) => number;
  log?: Logger;
}

/** Thrown inside the message handler when the consumer asked for a retry; mapped to a retry directive. */
class RetryRequested extends Error {
  constructor(readonly messageId: string) {
    super(`retry requested for message ${messageId}`);
    this.name = 'RetryRequested';
  }
}

const defaultDelay = (attempts: number) => Math.min(900, 5 * 2 ** Math.max(0, attempts - 1));

/**
 * Translates a HypDriv queue consumer into the arguments of `@vercel/queue`'s `handleCallback`: each Vercel
 * delivery becomes a one-message `{ job, messages }` batch; a message id in the returned `retry` list is
 * redelivered after `retryDelaySeconds`, a thrown error follows Vercel's default retry, and
 * `jobs.queues[job].retry: 'none'` acknowledges instead of retrying. Use it directly when the route file
 * should call `handleCallback` itself (local development discovers consumers by the calling file):
 *
 * ```ts
 * export const POST = handleCallback(...toQueueCallback(consumer, { config }));
 * ```
 */
export function toQueueCallback(
  handler: QueueJobHandler,
  options: QueueConsumerOptions = {},
): [QueueMessageHandler, QueueCallbackOptions] {
  const topics = new Map<string, string>();
  for (const [name, topic] of Object.entries(options.config?.vercel.queues ?? {})) topics.set(topic, name);
  const jobFor = (topic: string) => options.job ?? topics.get(topic) ?? topic;
  const retryMode = (job: string) => options.config?.jobs.queues[job]?.retry ?? 'failed';
  const delay = options.retryDelaySeconds ?? defaultDelay;

  const messageHandler: QueueMessageHandler = async (message, metadata) => {
    const job = jobFor(metadata.topicName);
    const createdAt = metadata.createdAt instanceof Date ? metadata.createdAt : new Date(metadata.createdAt);
    const result = await handler({
      job,
      messages: [
        {
          id: metadata.messageId,
          timestamp: Number.isNaN(createdAt.getTime()) ? new Date().toISOString() : createdAt.toISOString(),
          body: message,
          attempts: metadata.deliveryCount,
        },
      ],
    });
    if (result && Array.isArray(result.retry) && result.retry.includes(metadata.messageId))
      throw new RetryRequested(metadata.messageId);
  };

  const callbackOptions: QueueCallbackOptions = {
    ...(options.visibilityTimeoutSeconds !== undefined
      ? { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds }
      : {}),
    retry(error, metadata) {
      if (retryMode(jobFor(metadata.topicName)) === 'none') return { acknowledge: true };
      if (error instanceof RetryRequested)
        return { afterSeconds: Math.max(0, Math.floor(delay(metadata.deliveryCount))) };
      return undefined;
    },
  };
  return [messageHandler, callbackOptions];
}

/**
 * A Route Handler consuming Vercel Queues deliveries with a HypDriv queue consumer (built on the registered
 * `handleCallback`, so authentication, visibility extension and acknowledgement stay the SDK's). Configure
 * the route as a queue trigger in `vercel.json` (`experimentalTriggers: [{ type: 'queue/v2beta', topic }]`).
 * Answers 503 while `@vercel/queue` is not registered, so Vercel redelivers later.
 *
 * ```ts
 * // app/api/jobs/emails/route.ts
 * export const POST = queueConsumer(async ({ job, messages }) => { … }, { config });
 * ```
 */
export function queueConsumer(
  handler: QueueJobHandler,
  options: QueueConsumerOptions = {},
): (request: Request) => Promise<Response> {
  const log = options.log ?? defaultLogger();
  let built: { handleCallback: QueueHandleCallbackFn; route: (request: Request) => Promise<Response> } | null = null;
  return async (request) => {
    const queue = getVercelSdk().queue;
    if (!queue) {
      warnOnce(log, 'vercel-queue:not-registered', NOT_REGISTERED);
      return json({ error: 'queue_unavailable', message: '@vercel/queue is not registered' }, { status: 503 });
    }
    if (!built || built.handleCallback !== queue.handleCallback) {
      try {
        built = { handleCallback: queue.handleCallback, route: queue.handleCallback(...toQueueCallback(handler, options)) };
      } catch (error) {
        log.error('vercel queue: handleCallback setup failed', { error: toError(error).message });
        return json({ error: 'queue_unavailable' }, { status: 503 });
      }
    }
    return built.route(request);
  };
}

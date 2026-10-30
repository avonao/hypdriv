import { loadConfig } from '@hypdriv/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger } from './__fixtures__/fakes';
import { queueConsumer, queueTopic, toQueueCallback, vercelQueue } from './queues';
import {
  __resetVercelSdk,
  type QueueCallbackOptions,
  type QueueMessageHandler,
  type QueueMessageMetadata,
  type QueueSendOptions,
  registerVercelSdk,
} from './sdk';
import { __resetWarnings } from './util';

const config = loadConfig({
  vercel: { queues: { emails: 'email-topic' } },
  jobs: {
    queues: { emails: { path: '/api/jobs/emails' }, audit: { path: '/api/jobs/audit', retry: 'none' } },
  },
});

const sent: Array<[string, unknown, QueueSendOptions | undefined]> = [];
const send = async (topic: string, payload: unknown, options?: QueueSendOptions) => {
  sent.push([topic, payload, options]);
  return { messageId: `m${sent.length}` };
};

function metadata(partial: Partial<QueueMessageMetadata> = {}): QueueMessageMetadata {
  return {
    messageId: 'msg-1',
    deliveryCount: 1,
    createdAt: new Date('2026-10-30T12:00:00Z'),
    expiresAt: new Date('2026-10-31T12:00:00Z'),
    topicName: 'email-topic',
    consumerGroup: 'default',
    region: 'iad1',
    ...partial,
  };
}

beforeEach(() => {
  sent.length = 0;
  __resetVercelSdk();
  __resetWarnings();
});
afterEach(() => __resetVercelSdk());

describe('vercelQueue', () => {
  it('sends to the mapped topic and maps delaySeconds', async () => {
    registerVercelSdk({ queue: { send, handleCallback: () => async () => new Response() } });
    expect(queueTopic('emails', config)).toBe('email-topic');
    expect(queueTopic('other', config)).toBe('other');
    const queue = vercelQueue<{ to: string }>('emails', config);
    await queue.send({ to: 'a@example.com' });
    await queue.send({ to: 'b@example.com' }, { delaySeconds: 30.9 });
    await vercelQueue('other', config).send('x', { delaySeconds: 0 });
    expect(sent).toEqual([
      ['email-topic', { to: 'a@example.com' }, undefined],
      ['email-topic', { to: 'b@example.com' }, { delaySeconds: 30 }],
      ['other', 'x', undefined],
    ]);
  });

  it('throws E_UNSUPPORTED when @vercel/queue is not registered', async () => {
    await expect(vercelQueue('emails', config).send({})).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
  });

  it('batches with sendBatch in chunks of 100 and reports rejected messages', async () => {
    const batches: Array<[string, number]> = [];
    registerVercelSdk({
      queue: {
        send,
        handleCallback: () => async () => new Response(),
        sendBatch: async (topic, messages) => {
          batches.push([topic, messages.length]);
          return messages.map((m, i) =>
            (m.payload as number) === 150
              ? { status: 'failed' as const, statusCode: 413, error: 'too large', retryable: false }
              : i % 2
                ? { status: 'deferred' as const, messageId: null }
                : { status: 'sent' as const, messageId: `id${i}` },
          );
        },
      },
    });
    const queue = vercelQueue<number>('emails', config);
    await queue.sendBatch!(Array.from({ length: 120 }, (_, i) => ({ body: i, delaySeconds: 5 })));
    expect(batches).toEqual([
      ['email-topic', 100],
      ['email-topic', 20],
    ]);
    await expect(queue.sendBatch!([{ body: 150 }, { body: 1 }])).rejects.toThrow(/rejected 1 of 2/);
    await queue.sendBatch!([]);
    expect(batches).toHaveLength(3);
  });

  it('falls back to individual sends without sendBatch', async () => {
    registerVercelSdk({ queue: { send, handleCallback: () => async () => new Response() } });
    await vercelQueue('emails', config).sendBatch!([{ body: 1 }, { body: 2, delaySeconds: 10 }]);
    expect(sent).toEqual([
      ['email-topic', 1, undefined],
      ['email-topic', 2, { delaySeconds: 10 }],
    ]);
  });
});

describe('toQueueCallback', () => {
  it('hands each delivery to the consumer as a one-message batch named after the HypDriv queue', async () => {
    const inputs: unknown[] = [];
    const [handler, options] = toQueueCallback(async (input) => void inputs.push(input), {
      config,
      visibilityTimeoutSeconds: 120,
    });
    await handler({ to: 'a' }, metadata({ deliveryCount: 2 }));
    expect(inputs).toEqual([
      {
        job: 'emails',
        messages: [{ id: 'msg-1', timestamp: '2026-10-30T12:00:00.000Z', body: { to: 'a' }, attempts: 2 }],
      },
    ]);
    expect(options.visibilityTimeoutSeconds).toBe(120);
  });

  it('turns a requested retry into a delayed redelivery and leaves errors to the SDK', async () => {
    const [handler, options] = toQueueCallback(async ({ messages }) => ({ retry: [messages[0]!.id] }), {
      config,
    });
    const error = await Promise.resolve(handler({}, metadata())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(options.retry!(error, metadata({ deliveryCount: 1 }))).toEqual({ afterSeconds: 5 });
    expect(options.retry!(error, metadata({ deliveryCount: 4 }))).toEqual({ afterSeconds: 40 });
    expect(options.retry!(error, metadata({ deliveryCount: 20 }))).toEqual({ afterSeconds: 900 });
    expect(options.retry!(new Error('boom'), metadata())).toBeUndefined();
    // Retrying other ids does not affect this message.
    const [other] = toQueueCallback(async () => ({ retry: ['someone-else'] }), { config });
    await expect(Promise.resolve(other({}, metadata()))).resolves.toBeUndefined();
  });

  it("acknowledges instead of retrying for retry: 'none' and honours custom delays and job names", async () => {
    const [, none] = toQueueCallback(async () => undefined, { config });
    expect(none.retry!(new Error('x'), metadata({ topicName: 'audit' }))).toEqual({ acknowledge: true });
    const [handler, custom] = toQueueCallback(async (input) => ({ retry: input.messages.map((m) => m.id) }), {
      job: 'fixed',
      retryDelaySeconds: (attempts) => attempts * 7.5,
    });
    const error = await Promise.resolve(handler({}, metadata({ deliveryCount: 2 }))).catch((e: unknown) => e);
    expect(custom.retry!(error, metadata({ deliveryCount: 2 }))).toEqual({ afterSeconds: 15 });
    expect('visibilityTimeoutSeconds' in custom).toBe(false);
  });
});

describe('queueConsumer', () => {
  it('answers 503 until @vercel/queue is registered', async () => {
    const log = captureLogger();
    const route = queueConsumer(async () => undefined, { log });
    const response = await route(new Request('https://app.example.com/api/jobs/emails', { method: 'POST' }));
    expect(response.status).toBe(503);
    expect(log.lines[0]?.message).toContain('not registered');
  });

  it('builds the SDK callback handler once per registered handleCallback', async () => {
    const built: Array<[QueueMessageHandler, QueueCallbackOptions | undefined]> = [];
    const handleCallback = (handler: QueueMessageHandler, options?: QueueCallbackOptions) => {
      built.push([handler, options]);
      return async (request: Request) => {
        await handler(await request.json(), metadata());
        return Response.json({ status: 'success' });
      };
    };
    registerVercelSdk({ queue: { send, handleCallback } });
    const bodies: unknown[] = [];
    const route = queueConsumer(async ({ messages }) => void bodies.push(messages[0]!.body), { config });
    const post = () =>
      new Request('https://app.example.com/q', { method: 'POST', body: JSON.stringify({ n: 1 }) });
    expect((await route(post())).status).toBe(200);
    expect((await route(post())).status).toBe(200);
    expect(built).toHaveLength(1);
    expect(bodies).toEqual([{ n: 1 }, { n: 1 }]);
    registerVercelSdk({ queue: { send, handleCallback: (h, o) => handleCallback(h, o) } });
    await route(post());
    expect(built).toHaveLength(2);
  });

  it('answers 503 when the SDK rejects the handler', async () => {
    registerVercelSdk({
      queue: {
        send,
        handleCallback: () => {
          throw new Error('no consumer group');
        },
      },
    });
    const log = captureLogger();
    const response = await queueConsumer(async () => undefined, { log })(
      new Request('https://app.example.com/q'),
    );
    expect(response.status).toBe(503);
    expect(log.lines[0]).toMatchObject({ level: 'error' });
  });
});

import type {
  AnalyticsEngineLike,
  ExecutionContextLike,
  QueueLike,
  RateLimitBindingLike,
} from '@hypdriv/core';
import { createClock, type FakeClock } from '../clock';

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export type QueueContentType = 'json' | 'text' | 'bytes' | 'v8';

export interface FakeQueueMessage<Body = unknown> {
  id: string;
  body: Body;
  contentType: QueueContentType;
  delaySeconds: number;
  timestamp: Date;
  attempts: number;
}

export interface FakeQueue<Body = unknown> extends QueueLike<Body> {
  send(body: Body, options?: { contentType?: QueueContentType; delaySeconds?: number }): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: Body; contentType?: QueueContentType; delaySeconds?: number }>,
  ): Promise<void>;
  /** Messages sent so far (oldest first). */
  readonly messages: readonly FakeQueueMessage<Body>[];
  readonly size: number;
  /** Returns every pending message and empties the queue (simulates a consumer batch). */
  drain(): FakeQueueMessage<Body>[];
  clear(): void;
}

/** Records `send`/`sendBatch` calls; `drain()` hands them to your consumer under test. */
export function createFakeQueue<Body = unknown>(options: { clock?: FakeClock } = {}): FakeQueue<Body> {
  const clock = options.clock ?? createClock();
  let messages: FakeQueueMessage<Body>[] = [];
  let counter = 0;
  const push = (body: Body, sendOptions: { contentType?: QueueContentType; delaySeconds?: number } = {}) => {
    messages.push({
      id: `msg-${++counter}`,
      body,
      contentType: sendOptions.contentType ?? 'json',
      delaySeconds: sendOptions.delaySeconds ?? 0,
      timestamp: new Date(clock.now()),
      attempts: 1,
    });
  };
  return {
    get messages() {
      return messages;
    },
    get size() {
      return messages.length;
    },
    async send(body, sendOptions) {
      push(body, sendOptions);
    },
    async sendBatch(batch) {
      for (const m of batch) push(m.body, m);
    },
    drain() {
      const out = messages;
      messages = [];
      return out;
    },
    clear() {
      messages = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Analytics Engine
// ---------------------------------------------------------------------------

export interface FakeDataPoint {
  indexes: string[];
  blobs: Array<string | null>;
  doubles: number[];
}

export interface FakeAnalyticsEngine extends AnalyticsEngineLike {
  writeDataPoint(event: { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }): void;
  readonly dataPoints: readonly FakeDataPoint[];
  readonly size: number;
  clear(): void;
}

/** Records `writeDataPoint` calls (normalised to arrays). */
export function createFakeAnalyticsEngine(): FakeAnalyticsEngine {
  let dataPoints: FakeDataPoint[] = [];
  return {
    get dataPoints() {
      return dataPoints;
    },
    get size() {
      return dataPoints.length;
    },
    writeDataPoint(event) {
      dataPoints.push({
        indexes: [...(event.indexes ?? [])],
        blobs: [...(event.blobs ?? [])],
        doubles: [...(event.doubles ?? [])],
      });
    },
    clear() {
      dataPoints = [];
    },
  };
}

// ---------------------------------------------------------------------------
// ExecutionContext
// ---------------------------------------------------------------------------

export interface FakeExecutionContext extends ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
  /** Promises registered and not yet settled. */
  readonly pending: number;
  /** `true` once `passThroughOnException()` was called. */
  readonly passedThrough: boolean;
  /** Rejections of `waitUntil` promises, collected instead of thrown. */
  readonly errors: unknown[];
  /** Awaits every `waitUntil` promise, including ones registered while flushing. */
  flush(): Promise<void>;
}

/** Collects `waitUntil` promises so tests can `await ctx.flush()` before asserting side effects. */
export function createFakeExecutionContext(props: Record<string, unknown> = {}): FakeExecutionContext {
  const pending = new Set<Promise<unknown>>();
  const errors: unknown[] = [];
  let passedThrough = false;
  return {
    props,
    get pending() {
      return pending.size;
    },
    get passedThrough() {
      return passedThrough;
    },
    get errors() {
      return errors;
    },
    waitUntil(promise) {
      const tracked = Promise.resolve(promise)
        .catch((err: unknown) => {
          errors.push(err);
        })
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    passThroughOnException() {
      passedThrough = true;
    },
    async flush() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

// ---------------------------------------------------------------------------
// Rate Limiting binding
// ---------------------------------------------------------------------------

export interface FakeRateLimitBinding extends RateLimitBindingLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
  /** Current count per key in the active window. */
  counts(): Record<string, number>;
  reset(): void;
  readonly clock: FakeClock;
}

/**
 * Cloudflare's Rate Limiting binding: fixed windows of `periodSeconds` (10 or 60 in production) with
 * `limit` requests per key, evaluated on the controllable clock.
 */
export function createFakeRateLimitBinding(options: {
  limit: number;
  periodSeconds?: number;
  clock?: FakeClock;
}): FakeRateLimitBinding {
  const clock = options.clock ?? createClock();
  const period = (options.periodSeconds ?? 60) * 1000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    get clock() {
      return clock;
    },
    async limit({ key }) {
      const now = clock.now();
      let w = windows.get(key);
      if (!w || now - w.start >= period) {
        w = { start: now - (now % period), count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return { success: w.count <= options.limit };
    },
    counts() {
      const out: Record<string, number> = {};
      const now = clock.now();
      for (const [key, w] of windows) if (now - w.start < period) out[key] = w.count;
      return out;
    },
    reset() {
      windows.clear();
    },
  };
}

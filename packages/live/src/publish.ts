import type { HypDrivEnv, Logger } from '@hypdriv/core';
import { getChannelStub } from './handler';
import {
  DEFAULT_MAX_SUBSCRIBERS,
  DEFAULT_RETAIN,
  isValidChannelName,
  LIVE_DO_ORIGIN,
  LIVE_DO_PATHS,
  LIVE_HEADERS,
  type LiveEvent,
  type LivePublishInput,
  type LivePublishResponse,
} from './protocol';

export interface PublishOptions {
  /** Durable Object binding name (default `HYPDRIV_CHANNEL`, i.e. `config.live.binding`). */
  binding?: string;
  /** Retained events per channel (default 50, i.e. `config.live.retain`). */
  retain?: number;
  /** Subscriber cap per channel (default 10000). */
  maxSubscribers?: number;
  log?: Logger;
}

export interface PublishResult<T = unknown> {
  delivered: boolean;
  transport: 'durable-object' | 'none';
  /** The stored event (with its assigned id and timestamp) when delivered. */
  event?: LiveEvent<T>;
  /** Subscribers connected to the object at publish time. */
  subscribers?: number;
  error?: string;
}

const DEFAULT_BINDING = 'HYPDRIV_CHANNEL';
let warnedMissingBinding = false;

/** Resets the once-per-isolate warning (tests). */
export function resetLiveWarnings(): void {
  warnedMissingBinding = false;
}

/**
 * Publishes an event to a channel from server code (Route Handlers, Server Actions, queue consumers).
 *
 * With the Durable Object binding the event is stored and broadcast to every subscriber; without it
 * the call is a no-op that returns `{ delivered: false, transport: 'none' }` and logs once per isolate
 * (ADR 0012). Never throws for delivery problems: inspect `delivered`/`error`.
 */
export async function publish<T = unknown>(
  env: HypDrivEnv | Record<string, unknown> | undefined,
  channel: string,
  event: LivePublishInput<T>,
  options: PublishOptions = {},
): Promise<PublishResult<T>> {
  if (!isValidChannelName(channel)) {
    return { delivered: false, transport: 'none', error: `invalid channel name "${channel}"` };
  }
  if (!event || typeof event.type !== 'string' || !event.type) {
    return { delivered: false, transport: 'none', error: 'event.type must be a non-empty string' };
  }
  const binding = options.binding ?? DEFAULT_BINDING;
  const stub = getChannelStub(env, binding, channel);
  if (!stub) {
    if (!warnedMissingBinding) {
      warnedMissingBinding = true;
      const message = `[hypdriv/live] publish("${channel}") skipped: Durable Object binding ${binding} is not configured; live channels run in polling mode`;
      if (options.log) options.log.warn(message, { channel, binding });
      else console.warn(message);
    }
    return { delivered: false, transport: 'none' };
  }
  try {
    const response = await stub.fetch(
      `${LIVE_DO_ORIGIN}${LIVE_DO_PATHS.publish}?channel=${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LIVE_HEADERS.channel]: channel,
          [LIVE_HEADERS.retain]: String(options.retain ?? DEFAULT_RETAIN),
          [LIVE_HEADERS.maxSubscribers]: String(options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS),
        },
        body: JSON.stringify({ type: event.type, data: event.data, ...(event.id ? { id: event.id } : {}) }),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        delivered: false,
        transport: 'durable-object',
        error: `publish failed: ${response.status} ${text}`.trim(),
      };
    }
    const body = (await response.json()) as LivePublishResponse<T>;
    return { delivered: true, transport: 'durable-object', event: body.event, subscribers: body.subscribers };
  } catch (err) {
    return {
      delivered: false,
      transport: 'durable-object',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Binds `env` and options once: `const live = createPublisher(env); await live('orders', { type: 'created' })`. */
export function createPublisher(
  env: HypDrivEnv | Record<string, unknown> | undefined,
  options: PublishOptions = {},
) {
  return <T = unknown>(channel: string, event: LivePublishInput<T>) =>
    publish<T>(env, channel, event, options);
}

/** Empties a channel's retained log (subscribers stay connected). */
export async function clearChannel(
  env: HypDrivEnv | Record<string, unknown> | undefined,
  channel: string,
  options: Pick<PublishOptions, 'binding'> = {},
): Promise<{ cleared: number; transport: 'durable-object' | 'none' }> {
  if (!isValidChannelName(channel)) return { cleared: 0, transport: 'none' };
  const stub = getChannelStub(env, options.binding ?? DEFAULT_BINDING, channel);
  if (!stub) return { cleared: 0, transport: 'none' };
  const response = await stub.fetch(
    `${LIVE_DO_ORIGIN}${LIVE_DO_PATHS.clear}?channel=${encodeURIComponent(channel)}`,
    {
      method: 'DELETE',
      headers: { [LIVE_HEADERS.channel]: channel },
    },
  );
  const body = (await response.json().catch(() => ({}))) as { cleared?: number };
  return { cleared: body.cleared ?? 0, transport: 'durable-object' };
}

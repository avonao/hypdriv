import {
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  type HypDrivEnv,
  type LiveConfig,
  type ResolvedConfig,
  trimTrailingSlashes,
} from '@hypdriv/core';
import {
  isValidChannelName,
  LIVE_DO_ORIGIN,
  LIVE_DO_PATHS,
  LIVE_HEADERS,
  type LiveEventsResponse,
  type LiveUnavailableResponse,
} from './protocol';

export type LiveAuthorize = NonNullable<LiveConfig['authorize']>;

export interface LiveHandlerContext {
  waitUntil?(promise: Promise<unknown>): void;
  /** Overrides `config.live.authorize` for this request (e.g. the Worker shell injecting a session check). */
  authorize?: LiveAuthorize;
}

export type LiveHandler = (request: Request, ctx?: LiveHandlerContext) => Promise<Response>;

/** Structural check for a Durable Object namespace binding. */
export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespaceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DurableObjectNamespaceLike).idFromName === 'function' &&
    typeof (value as DurableObjectNamespaceLike).get === 'function'
  );
}

/** Returns the channel stub for `channel`, or `null` when the binding is absent. */
export function getChannelStub(
  env: HypDrivEnv | Record<string, unknown> | undefined,
  binding: string,
  channel: string,
): DurableObjectStubLike | null {
  const ns = env?.[binding];
  if (!isDurableObjectNamespace(ns)) return null;
  return ns.get(ns.idFromName(channel));
}

/** Parses `<basePath>/<channel>[/events|/stats]`; `null` when the URL is outside the live namespace. */
export function parseLivePath(
  pathname: string,
  basePath: string,
): { channel: string; action: 'subscribe' | 'events' | 'stats' | 'unknown' } | null {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (!pathname.startsWith(`${base}/`)) return null;
  const rest = trimTrailingSlashes(pathname.slice(base.length + 1));
  if (!rest) return null;
  const [rawChannel, sub, ...more] = rest.split('/');
  let channel: string;
  try {
    channel = decodeURIComponent(rawChannel ?? '');
  } catch {
    channel = rawChannel ?? '';
  }
  if (more.length) return { channel, action: 'unknown' };
  if (sub === undefined) return { channel, action: 'subscribe' };
  if (sub === 'events') return { channel, action: 'events' };
  if (sub === 'stats') return { channel, action: 'stats' };
  return { channel, action: 'unknown' };
}

/**
 * Answers `/_hypdriv/live/<channel>` (path from `config.live.path`).
 *
 * - `GET <channel>` with `Accept: text/event-stream` or `Upgrade: websocket` subscribes;
 *   `GET <channel>/events?after=` polls; `GET <channel>/stats` reports counts.
 * - Publishing is **server-side only** (`publish()`); `POST`/`DELETE` here answer 405.
 * - `config.live.authorize` (or `ctx.authorize`) gates every request with 403.
 * - Channel names must match `^[a-zA-Z0-9:_-]{1,128}$` (400 otherwise).
 * - With the Durable Object binding (`config.live.binding`, default `HYPDRIV_CHANNEL`) requests are
 *   forwarded to `idFromName(channel)` with the retain/max-subscriber limits as headers.
 * - Without it: subscriptions get `503 { error: 'live_unavailable', transport: 'polling' }` and
 *   `/events` returns an empty list with `transport: 'none'`, so clients fall back to polling the
 *   application's own endpoint (ADR 0012).
 */
export function createLiveHandler(
  config: ResolvedConfig,
  env: HypDrivEnv | Record<string, unknown>,
): LiveHandler {
  const live = config.live;
  return async (request, ctx = {}) => {
    const url = new URL(request.url);
    if (!live.enabled) return json({ error: 'live_disabled' }, 404);
    const parsed = parseLivePath(url.pathname, live.path);
    if (!parsed) return json({ error: 'not_found' }, 404);
    if (!isValidChannelName(parsed.channel)) {
      return json({ error: 'invalid_channel', detail: 'channel names match ^[a-zA-Z0-9:_-]{1,128}$' }, 400);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed', detail: 'publish from server code with publish()' }, 405, {
        allow: 'GET, HEAD',
      });
    }
    if (parsed.action === 'unknown') return json({ error: 'not_found' }, 404);

    const authorize = ctx.authorize ?? live.authorize;
    if (authorize) {
      let allowed = false;
      try {
        allowed = await authorize({ channel: parsed.channel, headers: request.headers, url });
      } catch {
        allowed = false;
      }
      if (!allowed) return json({ error: 'forbidden', channel: parsed.channel }, 403);
    }

    const stub = getChannelStub(env, live.binding, parsed.channel);
    const wantsWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';

    if (!stub) {
      if (parsed.action === 'events') {
        const body: LiveEventsResponse = {
          channel: parsed.channel,
          events: [],
          cursor: null,
          transport: 'none',
        };
        return json(body, 200, { 'cache-control': 'no-store', [LIVE_HEADERS.transport]: 'none' });
      }
      if (parsed.action === 'stats') {
        return json({
          channel: parsed.channel,
          transport: 'none',
          subscribers: { websocket: 0, sse: 0 },
          events: 0,
        });
      }
      const body: LiveUnavailableResponse = {
        error: 'live_unavailable',
        transport: 'polling',
        pollIntervalMs: live.pollIntervalMs,
      };
      return json(body, 503, {
        'retry-after': String(Math.ceil(live.pollIntervalMs / 1000)),
        [LIVE_HEADERS.transport]: 'none',
      });
    }

    const target = new URL(LIVE_DO_ORIGIN);
    target.pathname =
      parsed.action === 'events'
        ? LIVE_DO_PATHS.events
        : parsed.action === 'stats'
          ? LIVE_DO_PATHS.stats
          : LIVE_DO_PATHS.subscribe;
    target.search = url.search;
    target.searchParams.set('channel', parsed.channel);
    if (parsed.action === 'subscribe' && !wantsWebSocket) {
      target.searchParams.set('transport', 'sse');
    }

    const headers = new Headers(request.headers);
    headers.set(LIVE_HEADERS.channel, parsed.channel);
    headers.set(LIVE_HEADERS.retain, String(live.retain));
    headers.set(LIVE_HEADERS.maxSubscribers, String(live.maxSubscribers));
    if (parsed.action === 'subscribe' && !wantsWebSocket) headers.set('accept', 'text/event-stream');

    const forwarded = new Request(target.toString(), { method: 'GET', headers });
    return stub.fetch(forwarded);
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

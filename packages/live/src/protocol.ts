/**
 * Wire protocol shared by the Durable Object, the Worker handler, `publish()` and the browser client.
 *
 * Transport summary:
 * - SSE frames carry the full event as JSON in `data:` (no `event:` field, so `EventSource.onmessage`
 *   receives every type) and the event id in `id:`.
 * - WebSocket frames are the same JSON objects; control frames have no `id` (`{"type":"pong"}`).
 * - Polling clients `GET <path>/<channel>/events?after=<id|seq>` and receive `LiveEventsResponse`.
 */

/** One published event as delivered to subscribers. */
export interface LiveEvent<T = unknown> {
  /** UUIDv7 (time-ordered) unless the publisher supplied its own id. */
  id: string;
  type: string;
  data: T;
  /** Publish time, epoch milliseconds. */
  ts: number;
}

/** What server code passes to `publish()`. */
export interface LivePublishInput<T = unknown> {
  type: string;
  data?: T;
  /** Custom id (idempotent publishes). Keep it time-sortable or replay-after-id becomes approximate. */
  id?: string;
}

/** Response body of the polling endpoint and of the Durable Object's `/events` route. */
export interface LiveEventsResponse<T = unknown> {
  channel: string;
  events: LiveEvent<T>[];
  /** Pass as `after` on the next poll; `null` when nothing has ever been published. */
  cursor: string | null;
  transport: 'durable-object' | 'none';
}

/** Body of the 503 the handler returns for SSE/WebSocket requests when no Durable Object is bound. */
export interface LiveUnavailableResponse {
  error: 'live_unavailable';
  transport: 'polling';
  pollIntervalMs: number;
}

/** Response body of a successful publish. */
export interface LivePublishResponse<T = unknown> {
  ok: true;
  event: LiveEvent<T>;
  seq: number;
  subscribers: number;
}

/** Response body of the Durable Object's `/stats` route. */
export interface LiveChannelStats {
  channel: string;
  subscribers: { websocket: number; sse: number };
  events: number;
  seq: number;
  lastId: string | null;
}

/** Internal headers the handler/publisher send to the Durable Object. */
export const LIVE_HEADERS = {
  channel: 'x-hypdriv-live-channel',
  retain: 'x-hypdriv-live-retain',
  maxSubscribers: 'x-hypdriv-live-max-subscribers',
  /** Set on responses so clients and tests can see which transport answered. */
  transport: 'x-hypdriv-live-transport',
} as const;

/** Durable Object routes (the Worker handler maps public URLs onto these). */
export const LIVE_DO_PATHS = {
  subscribe: '/subscribe',
  publish: '/publish',
  events: '/events',
  stats: '/stats',
  clear: '/clear',
} as const;

/** Synthetic origin for stub requests (Durable Object fetches ignore the host). */
export const LIVE_DO_ORIGIN = 'https://hypdriv.live';

export const DEFAULT_LIVE_PATH = '/_hypdriv/live';
export const DEFAULT_RETAIN = 50;
export const DEFAULT_MAX_SUBSCRIBERS = 10000;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
/** SSE heartbeat comment interval. */
export const HEARTBEAT_MS = 25_000;
/** `retry:` hint sent at the start of every SSE stream (browser auto-reconnect delay). */
export const SSE_RETRY_MS = 3000;
/** Maximum serialised event size accepted by `/publish`. */
export const MAX_EVENT_BYTES = 128 * 1024;
/** Upper bound for `?limit=` on `/events`. */
export const MAX_EVENTS_PER_PAGE = 1000;

/** Channel names: 1–128 characters of `[a-zA-Z0-9:_-]`. */
export const CHANNEL_NAME_RE = /^[a-zA-Z0-9:_-]{1,128}$/;

export function isValidChannelName(name: unknown): name is string {
  return typeof name === 'string' && CHANNEL_NAME_RE.test(name);
}

/** Validates an untrusted JSON value as a `LiveEvent`. */
export function parseLiveEvent(raw: unknown): LiveEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 128) return null;
  if (typeof e.type !== 'string' || e.type.length === 0) return null;
  const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
  return { id: e.id, type: e.type, data: e.data === undefined ? null : e.data, ts };
}

/** Formats one event as an SSE frame. */
export function formatSseEvent(event: LiveEvent): string {
  // JSON never contains raw newlines, so a single data line is enough.
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatSseComment(text: string): string {
  return `: ${text.replace(/[\r\n]+/g, ' ')}\n\n`;
}

export function formatSseRetry(ms: number): string {
  return `retry: ${Math.max(0, Math.floor(ms))}\n\n`;
}

/**
 * Parses SSE text into events. Returns the events found and the unconsumed remainder (a partial frame),
 * so callers can feed streamed chunks incrementally.
 */
export function parseSse(text: string): { events: LiveEvent[]; rest: string } {
  const events: LiveEvent[] = [];
  const frames = text.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    let data = '';
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
    }
    if (!data) continue;
    try {
      const event = parseLiveEvent(JSON.parse(data));
      if (event) events.push(event);
    } catch {
      // ignore malformed frames
    }
  }
  return { events, rest };
}

/** Builds the public subscription URL for a channel. */
export function liveChannelUrl(
  basePath: string,
  channel: string,
  suffix: '' | 'events' | 'stats' = '',
): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${base}/${encodeURIComponent(channel)}${suffix ? `/${suffix}` : ''}`;
}

import {
  DEFAULT_LIVE_PATH,
  DEFAULT_POLL_INTERVAL_MS,
  type LiveEvent,
  type LiveEventsResponse,
  liveChannelUrl,
  parseLiveEvent,
} from './protocol';

export type LiveTransport = 'sse' | 'websocket' | 'polling';
export type LiveTransportOption = 'auto' | LiveTransport;
export type LiveStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface LiveStatusInfo {
  transport: LiveTransport | null;
  error?: string;
  /** Reconnect attempt number (0 while healthy). */
  attempt: number;
}

/** Minimal `EventSource` surface the client uses (so tests can inject a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveClientOptions<T = unknown> {
  channel: string;
  /** Base path of the live handler (default `/_hypdriv/live`). */
  path?: string;
  /** Origin for the URLs (default `location.origin`). */
  origin?: string;
  transport?: LiveTransportOption;
  /** Polling interval (default 5000 ms; the server's 503 body may raise it). */
  pollIntervalMs?: number;
  /** Polling URL override (defaults to `<path>/<channel>/events`); must answer `LiveEventsResponse`. */
  pollUrl?: string;
  /** Resume after this id (replay from the retained log). */
  lastEventId?: string | null;
  /** Only dispatch these event types. */
  types?: string[];
  onEvent?: (event: LiveEvent<T>) => void;
  onStatus?: (status: LiveStatus, info: LiveStatusInfo) => void;
  /** Injectable platform APIs (tests, non-browser runtimes). */
  fetch?: typeof fetch;
  EventSource?: new (url: string) => EventSourceLike;
  WebSocket?: new (url: string) => WebSocketLike;
  /** Reconnect backoff: exponential from `baseMs` to `maxMs` with jitter. */
  reconnect?: { baseMs?: number; maxMs?: number; jitter?: boolean };
  /** Keep-alive ping interval for WebSockets (default 20000 ms). */
  pingIntervalMs?: number;
  /** Recent ids remembered to drop duplicates after reconnects (default 256). */
  dedupe?: number;
}

export interface LiveClient {
  readonly status: LiveStatus;
  readonly transport: LiveTransport | null;
  readonly lastEventId: string | null;
  /** Opens the connection (idempotent). */
  connect(): void;
  /** Closes permanently; the client cannot be reused. */
  close(): void;
}

const ES_CLOSED = 2;
const WS_OPEN = 1;

/**
 * Framework-agnostic connection manager behind `useLive()`.
 *
 * `auto` picks SSE when `EventSource` exists (WebSocket otherwise, polling as the last resort). When
 * the server answers the first subscription with 503 (`live_unavailable`), the client switches to
 * polling `pollUrl`. Drops reconnect with exponential backoff and resume from the last event id, and
 * duplicates delivered by replays are filtered.
 */
export function createLiveClient<T = unknown>(options: LiveClientOptions<T>): LiveClient {
  const path = options.path ?? DEFAULT_LIVE_PATH;
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost');
  const g = globalThis as {
    fetch?: typeof fetch;
    EventSource?: new (url: string) => EventSourceLike;
    WebSocket?: new (url: string) => WebSocketLike;
  };
  const fetchImpl = options.fetch ?? g.fetch;
  const EventSourceImpl = options.EventSource ?? g.EventSource;
  const WebSocketImpl = options.WebSocket ?? g.WebSocket;
  const baseMs = options.reconnect?.baseMs ?? 1000;
  const maxMs = options.reconnect?.maxMs ?? 30_000;
  const jitter = options.reconnect?.jitter ?? true;
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const types = options.types?.length ? new Set(options.types) : null;
  const dedupeSize = options.dedupe ?? 256;
  let pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const subscribeUrl = `${origin}${liveChannelUrl(path, options.channel)}`;
  const pollUrl = options.pollUrl
    ? options.pollUrl.startsWith('http')
      ? options.pollUrl
      : `${origin}${options.pollUrl}`
    : `${origin}${liveChannelUrl(path, options.channel, 'events')}`;

  let status: LiveStatus = 'closed';
  let transport: LiveTransport | null = null;
  let lastEventId: string | null = options.lastEventId ?? null;
  let closed = false;
  let started = false;
  let attempt = 0;
  let openedOnce = false;
  let es: EventSourceLike | null = null;
  let ws: WebSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  const seen: string[] = [];
  const seenSet = new Set<string>();

  const setStatus = (next: LiveStatus, error?: string) => {
    status = next;
    options.onStatus?.(next, { transport, attempt, ...(error ? { error } : {}) });
  };

  const remember = (id: string): boolean => {
    if (seenSet.has(id)) return false;
    seenSet.add(id);
    seen.push(id);
    if (seen.length > dedupeSize) {
      const old = seen.shift();
      if (old !== undefined) seenSet.delete(old);
    }
    return true;
  };

  const dispatch = (raw: unknown) => {
    const event = parseLiveEvent(raw);
    if (!event) return;
    if (!remember(event.id)) return;
    lastEventId = event.id;
    if (types && !types.has(event.type)) return;
    try {
      options.onEvent?.(event as LiveEvent<T>);
    } catch {
      // listener errors must not break the connection
    }
  };

  const handleText = (text: unknown) => {
    if (typeof text !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object' && !('id' in (parsed as object))) return; // control frame
    dispatch(parsed);
  };

  const withResume = (url: string, extra: Record<string, string> = {}) => {
    const u = new URL(url);
    if (lastEventId) u.searchParams.set('lastEventId', lastEventId);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const teardownSocket = () => {
    if (es) {
      const current = es;
      es = null;
      current.onopen = current.onmessage = current.onerror = null;
      current.close();
    }
    if (ws) {
      const current = ws;
      ws = null;
      current.onopen = current.onmessage = current.onclose = current.onerror = null;
      try {
        current.close(1000, 'client closed');
      } catch {
        // ignore
      }
    }
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  const backoff = () => {
    const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
    return jitter ? Math.round(exp * (0.5 + Math.random() * 0.5)) : exp;
  };

  const scheduleReconnect = (delay = backoff()) => {
    if (closed) return;
    attempt++;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (!closed) open();
    }, delay);
  };

  /** Asks the events endpoint whether the server can stream at all; 503/`transport: none` → polling. */
  const probeThenRecover = async (error: string) => {
    if (closed) return;
    if (!openedOnce && options.transport !== 'sse' && options.transport !== 'websocket' && fetchImpl) {
      try {
        const res = await fetchImpl(withResume(pollUrl), { headers: { accept: 'application/json' } });
        if (closed) return;
        if (res.status === 503) {
          const body = (await res.json().catch(() => null)) as Partial<{ pollIntervalMs: number }> | null;
          if (body?.pollIntervalMs) pollIntervalMs = body.pollIntervalMs;
          startPolling();
          return;
        }
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as Partial<LiveEventsResponse> | null;
          if (body?.transport === 'none') {
            startPolling();
            return;
          }
          for (const e of body?.events ?? []) dispatch(e);
        }
      } catch {
        // network error: fall through to backoff
      }
    }
    setStatus('error', error);
    scheduleReconnect();
  };

  const openSse = () => {
    if (!EventSourceImpl) {
      openWebSocket();
      return;
    }
    transport = 'sse';
    setStatus('connecting');
    const source = new EventSourceImpl(withResume(subscribeUrl));
    es = source;
    source.onopen = () => {
      if (es !== source) return;
      attempt = 0;
      openedOnce = true;
      setStatus('open');
    };
    source.onmessage = (ev) => {
      if (es !== source) return;
      handleText(ev.data);
    };
    source.onerror = () => {
      if (es !== source) return;
      if (source.readyState === ES_CLOSED) {
        teardownSocket();
        void probeThenRecover('event source closed');
      } else {
        setStatus('connecting'); // the browser is reconnecting on its own (sends Last-Event-ID)
      }
    };
  };

  const openWebSocket = () => {
    if (!WebSocketImpl) {
      startPolling();
      return;
    }
    transport = 'websocket';
    setStatus('connecting');
    const wsUrl = withResume(subscribeUrl.replace(/^http/, 'ws'), { transport: 'websocket' });
    let socket: WebSocketLike;
    try {
      socket = new WebSocketImpl(wsUrl);
    } catch (err) {
      void probeThenRecover(err instanceof Error ? err.message : 'websocket failed');
      return;
    }
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      attempt = 0;
      openedOnce = true;
      setStatus('open');
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WS_OPEN) {
          try {
            socket.send('{"type":"ping"}');
          } catch {
            // closing
          }
        }
      }, pingIntervalMs);
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      handleText(ev.data);
    };
    socket.onerror = () => {
      // onclose follows and carries the code
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      teardownSocket();
      if (closed) return;
      if (ev.code === 1013) {
        setStatus('error', 'too many subscribers');
        scheduleReconnect(Math.max(backoff(), 5000));
        return;
      }
      void probeThenRecover(`websocket closed (${ev.code})`);
    };
  };

  const poll = async () => {
    if (closed || !polling) return;
    if (!fetchImpl) {
      setStatus('error', 'fetch is not available');
      return;
    }
    let delay = pollIntervalMs;
    try {
      const u = new URL(pollUrl);
      if (lastEventId) u.searchParams.set('after', lastEventId);
      const res = await fetchImpl(u.toString(), { headers: { accept: 'application/json' } });
      if (closed || !polling) return;
      if (res.ok) {
        const body = (await res.json()) as Partial<LiveEventsResponse>;
        for (const e of body.events ?? []) dispatch(e);
        if (!lastEventId && body.cursor) lastEventId = body.cursor;
        attempt = 0;
        if (status !== 'open') setStatus('open');
      } else {
        attempt++;
        const retryAfter = Number(res.headers.get('retry-after'));
        delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(maxMs, pollIntervalMs * 2);
        setStatus('error', `poll failed: ${res.status}`);
      }
    } catch (err) {
      if (closed || !polling) return;
      attempt++;
      delay = Math.min(maxMs, pollIntervalMs * 2 ** Math.min(attempt, 4));
      setStatus('error', err instanceof Error ? err.message : 'poll failed');
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delay);
  };

  const startPolling = () => {
    if (closed) return;
    teardownSocket();
    transport = 'polling';
    polling = true;
    setStatus('connecting');
    void poll();
  };

  const open = () => {
    if (closed) return;
    teardownSocket();
    const preferred = options.transport ?? 'auto';
    if (preferred === 'polling') startPolling();
    else if (preferred === 'websocket') openWebSocket();
    else openSse();
  };

  return {
    get status() {
      return status;
    },
    get transport() {
      return transport;
    },
    get lastEventId() {
      return lastEventId;
    },
    connect() {
      if (started || closed) return;
      started = true;
      open();
    },
    close() {
      if (closed) return;
      closed = true;
      polling = false;
      clearTimer();
      teardownSocket();
      setStatus('closed');
    },
  };
}

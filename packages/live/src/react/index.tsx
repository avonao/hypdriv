'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  createLiveClient,
  type LiveClient,
  type LiveStatus,
  type LiveTransport,
  type LiveTransportOption,
} from '../client';
import { DEFAULT_LIVE_PATH, DEFAULT_POLL_INTERVAL_MS, type LiveEvent } from '../protocol';

export type { LiveEvent, LiveStatus, LiveTransport, LiveTransportOption };

export interface LiveContextValue {
  /** Base path of the live handler (`config.live.path`). */
  path: string;
  transport: LiveTransportOption;
  pollIntervalMs: number;
}

const LiveContext = createContext<LiveContextValue>({
  path: DEFAULT_LIVE_PATH,
  transport: 'auto',
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
});

export interface LiveProviderProps extends Partial<LiveContextValue> {
  children?: ReactNode;
}

/** Sets the base path / transport defaults for every `useLive` below it (mirror `config.live`). */
export function LiveProvider({ path, transport, pollIntervalMs, children }: LiveProviderProps) {
  const parent = useContext(LiveContext);
  const value: LiveContextValue = {
    path: path ?? parent.path,
    transport: transport ?? parent.transport,
    pollIntervalMs: pollIntervalMs ?? parent.pollIntervalMs,
  };
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export interface UseLiveOptions<T = unknown> {
  onEvent?: (event: LiveEvent<T>) => void;
  transport?: LiveTransportOption;
  /** Base path override (default from `LiveProvider`, then `/_hypdriv/live`). */
  path?: string;
  /** `false` keeps the hook idle (status `closed`). Default `true`. */
  enabled?: boolean;
  pollIntervalMs?: number;
  /** Resume from this event id on first connect (replays the retained log after it). */
  lastEventId?: string | null;
  /** Polling endpoint override; must answer `{ events, cursor }` like `<path>/<channel>/events`. */
  pollUrl?: string;
  /** Only dispatch these event types. */
  types?: string[];
  /** Number of events kept in `events` (default 100). */
  maxEvents?: number;
}

export interface UseLiveResult<T = unknown> {
  status: LiveStatus;
  /** Transport in use once connected (`sse`, `websocket` or `polling`). */
  transport: LiveTransport | null;
  lastEvent: LiveEvent<T> | null;
  /** Most recent events, oldest first, capped at `maxEvents`. */
  events: LiveEvent<T>[];
  error: string | null;
  /** Closes the connection for the lifetime of this component instance. */
  close: () => void;
}

/**
 * Subscribes to a channel. SSE by default with automatic reconnect and resume, WebSocket on request,
 * polling when the server has no Durable Object (it answers 503 and the client switches by itself).
 * SSR-safe: nothing connects until the effect runs in the browser.
 */
export function useLive<T = unknown>(channel: string, options: UseLiveOptions<T> = {}): UseLiveResult<T> {
  const ctx = useContext(LiveContext);
  const enabled = options.enabled ?? true;
  const path = options.path ?? ctx.path;
  const transport = options.transport ?? ctx.transport;
  const pollIntervalMs = options.pollIntervalMs ?? ctx.pollIntervalMs;
  const maxEvents = options.maxEvents ?? 100;
  const typesKey = options.types?.join('\u0000') ?? '';
  const { pollUrl, lastEventId } = options;

  const [status, setStatus] = useState<LiveStatus>(enabled ? 'connecting' : 'closed');
  const [activeTransport, setActiveTransport] = useState<LiveTransport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LiveEvent<T>[]>([]);
  const [lastEvent, setLastEvent] = useState<LiveEvent<T> | null>(null);

  const onEventRef = useRef(options.onEvent);
  useEffect(() => {
    onEventRef.current = options.onEvent;
  });
  const clientRef = useRef<LiveClient | null>(null);
  const initialLastEventId = useRef(lastEventId ?? null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setStatus('closed');
      return;
    }
    const client = createLiveClient<T>({
      channel,
      path,
      transport,
      pollIntervalMs,
      pollUrl,
      lastEventId: initialLastEventId.current,
      types: typesKey ? typesKey.split('\u0000') : undefined,
      onEvent(event) {
        initialLastEventId.current = event.id;
        setLastEvent(event);
        setEvents((prev) => {
          const next = prev.length >= maxEvents ? prev.slice(prev.length - maxEvents + 1) : prev.slice();
          next.push(event);
          return next;
        });
        onEventRef.current?.(event);
      },
      onStatus(next, info) {
        setStatus(next);
        setActiveTransport(info.transport);
        setError(info.error ?? null);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [channel, enabled, path, transport, pollIntervalMs, pollUrl, typesKey, maxEvents]);

  const close = useCallback(() => {
    clientRef.current?.close();
  }, []);

  return { status, transport: activeTransport, lastEvent, events, error, close };
}

export interface UseLiveValueOptions<T, E = unknown> extends Omit<UseLiveOptions<E>, 'onEvent'> {
  /** Maps an event to the value (default: `event.data`). */
  select?: (event: LiveEvent<E>, previous: T) => T;
}

/** Keeps the latest value published on a channel (`event.data` by default). */
export function useLiveValue<T, E = T>(
  channel: string,
  initial: T,
  options: UseLiveValueOptions<T, E> = {},
): T {
  const [value, setValue] = useState<T>(initial);
  const selectRef = useRef(options.select);
  useEffect(() => {
    selectRef.current = options.select;
  });
  const { select: _select, ...rest } = options;
  useLive<E>(channel, {
    ...rest,
    onEvent: (event) => {
      setValue((previous) =>
        selectRef.current ? selectRef.current(event, previous) : (event.data as unknown as T),
      );
    },
  });
  return value;
}

export interface UseLiveRefreshOptions extends Omit<UseLiveOptions, 'onEvent'> {
  /** Coalesces bursts of events into one refresh (default 150 ms). */
  debounceMs?: number;
}

/**
 * Calls `refresh` (typically `useRouter().refresh` from `next/navigation`) whenever the channel
 * publishes, debounced. Returns the underlying subscription state.
 */
export function useLiveRefresh(
  channel: string,
  refresh: () => void,
  options: UseLiveRefreshOptions = {},
): UseLiveResult {
  const debounceMs = options.debounceMs ?? 150;
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const { debounceMs: _debounce, ...rest } = options;
  return useLive(channel, {
    ...rest,
    onEvent: () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        refreshRef.current();
      }, debounceMs);
    },
  });
}

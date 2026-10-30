import { HypDrivError } from '@hypdriv/core';

/** A text-frame transport to a DevTools endpoint (a WebSocket, or an in-memory fake in tests). */
export interface CdpTransport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

export type CdpConnect = (url: string) => Promise<CdpTransport>;

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpWaitOptions {
  sessionId?: string;
  timeoutMs?: number;
  filter?: (event: CdpEvent) => boolean;
}

export interface CdpClient {
  /** Sends a command; resolves with its `result`, rejects with `E_UPSTREAM` on a protocol error. */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  /** Subscribes to an event; returns the unsubscribe function. */
  on(method: string, handler: (event: CdpEvent) => void): () => void;
  /** Resolves with the next matching event (optionally for one session), or rejects on timeout. */
  waitFor(method: string, options?: CdpWaitOptions): Promise<CdpEvent>;
  close(): void;
  readonly closed: boolean;
}

export interface CdpClientOptions {
  /** Default per-command and per-wait timeout (default 30 s). */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Encodes one CDP command frame. */
export function encodeCommand(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): string {
  return JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
}

export type CdpFrame =
  | { kind: 'response'; id: number; result?: unknown; error?: { code?: number; message: string }; sessionId?: string }
  | { kind: 'event'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { kind: 'invalid' };

/** Decodes one incoming frame into a response, an event or `invalid`. */
export function decodeFrame(data: string): CdpFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'invalid' };
  const frame = parsed as Record<string, unknown>;
  if (typeof frame.id === 'number') {
    return {
      kind: 'response',
      id: frame.id,
      result: frame.result,
      error: frame.error as { code?: number; message: string } | undefined,
      sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
    };
  }
  if (typeof frame.method === 'string') {
    return {
      kind: 'event',
      method: frame.method,
      params: (frame.params as Record<string, unknown>) ?? {},
      sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
    };
  }
  return { kind: 'invalid' };
}

/** A minimal Chrome DevTools Protocol client over any {@link CdpTransport}. */
export function createCdpClient(transport: CdpTransport, options: CdpClientOptions = {}): CdpClient {
  const defaultTimeout = options.timeoutMs ?? 30_000;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  let nextId = 0;
  let closed = false;

  const failAll = (reason: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new HypDrivError('E_UPSTREAM', `${p.method}: ${reason}`, { id }));
    }
    pending.clear();
  };

  transport.onMessage((data) => {
    const frame = decodeFrame(data);
    if (frame.kind === 'response') {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) {
        p.reject(
          new HypDrivError('E_UPSTREAM', `${p.method}: ${frame.error.message}`, {
            code: frame.error.code,
            method: p.method,
          }),
        );
      } else p.resolve(frame.result ?? {});
    } else if (frame.kind === 'event') {
      const event: CdpEvent = { method: frame.method, params: frame.params, sessionId: frame.sessionId };
      const handlers = listeners.get(frame.method);
      if (handlers) for (const h of [...handlers]) h(event);
      const any = listeners.get('*');
      if (any) for (const h of [...any]) h(event);
    }
  });

  transport.onClose((reason) => {
    closed = true;
    failAll(`connection closed${reason ? ` (${reason})` : ''}`);
  });

  const on: CdpClient['on'] = (method, handler) => {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  };

  return {
    get closed() {
      return closed;
    },
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      if (closed) return Promise.reject(new HypDrivError('E_UPSTREAM', `${method}: connection closed`));
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HypDrivError('E_TIMEOUT', `${method}: no response within ${defaultTimeout}ms`, { id }));
        }, defaultTimeout);
        timer.unref?.();
        pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
        try {
          transport.send(encodeCommand(id, method, params, sessionId));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new HypDrivError('E_UPSTREAM', `${method}: ${(err as Error).message}`, {}, { cause: err }));
        }
      });
    },
    on,
    waitFor(method, waitOptions = {}) {
      const timeoutMs = waitOptions.timeoutMs ?? defaultTimeout;
      return new Promise<CdpEvent>((resolve, reject) => {
        const off = on(method, (event) => {
          if (waitOptions.sessionId && event.sessionId !== waitOptions.sessionId) return;
          if (waitOptions.filter && !waitOptions.filter(event)) return;
          clearTimeout(timer);
          off();
          resolve(event);
        });
        const timer = setTimeout(() => {
          off();
          reject(new HypDrivError('E_TIMEOUT', `Timed out after ${timeoutMs}ms waiting for ${method}`));
        }, timeoutMs);
        timer.unref?.();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      failAll('client closed');
      try {
        transport.close();
      } catch {
        // ignore
      }
    },
  };
}

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void;
}

/** Connects with the runtime's global `WebSocket` (Node 22+). */
export const webSocketConnect: CdpConnect = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof Ctor !== 'function') {
    return Promise.reject(
      new HypDrivError(
        'E_UNSUPPORTED',
        'The Purser audit drives Chrome over a WebSocket and needs Node.js 22+ (global WebSocket)',
      ),
    );
  }
  return new Promise<CdpTransport>((resolve, reject) => {
    const ws = new Ctor(url);
    let opened = false;
    const messageHandlers: Array<(data: string) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];
    ws.addEventListener('open', () => {
      opened = true;
      resolve({
        send: (data) => ws.send(data),
        onMessage: (h) => void messageHandlers.push(h),
        onClose: (h) => void closeHandlers.push(h),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('message', (event) => {
      const data = (event as { data: unknown }).data;
      const text = typeof data === 'string' ? data : String(data);
      for (const h of messageHandlers) h(text);
    });
    ws.addEventListener('close', (event) => {
      const reason = (event as { reason?: string }).reason;
      for (const h of closeHandlers) h(reason);
    });
    ws.addEventListener('error', (event) => {
      const message = (event as { message?: string }).message ?? 'WebSocket error';
      if (!opened) reject(new HypDrivError('E_UPSTREAM', `Could not connect to ${url}: ${message}`));
      else for (const h of closeHandlers) h(message);
    });
  });
};

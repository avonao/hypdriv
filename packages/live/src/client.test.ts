import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveClient, type EventSourceLike, type LiveStatus, type WebSocketLike } from './client';
import { type LiveEvent, parseSse } from './protocol';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(event: LiveEvent) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: event.id });
  }
  fail() {
    this.readyState = 2;
    this.onerror?.({});
  }
  blip() {
    this.readyState = 0;
    this.onerror?.({});
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const ev = (id: string, type = 'tick', data: unknown = id): LiveEvent => ({ id, type, data, ts: 1 });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('createLiveClient', () => {
  const statuses: Array<{ status: LiveStatus; transport: string | null }> = [];
  const received: LiveEvent[] = [];
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    FakeWebSocket.instances = [];
    statuses.length = 0;
    received.length = 0;
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (options: Partial<Parameters<typeof createLiveClient>[0]> = {}) =>
    createLiveClient({
      channel: 'room',
      origin: 'https://app.test',
      fetch: fetchMock,
      EventSource: FakeEventSource,
      WebSocket: FakeWebSocket,
      reconnect: { baseMs: 100, maxMs: 1000, jitter: false },
      onEvent: (e) => received.push(e),
      onStatus: (status, info) => statuses.push({ status, transport: info.transport }),
      ...options,
    });

  it('uses SSE by default, dispatches events, dedupes and resumes with lastEventId', () => {
    const client = make({ lastEventId: 'e0' });
    client.connect();
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('https://app.test/_hypdriv/live/room?lastEventId=e0');
    expect(client.status).toBe('connecting');
    es.open();
    expect(client.status).toBe('open');
    expect(client.transport).toBe('sse');
    es.emit(ev('e1'));
    es.emit(ev('e1'));
    es.emit(ev('e2'));
    es.onmessage?.({ data: '{"type":"pong"}' });
    es.onmessage?.({ data: 'not json' });
    expect(received.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(client.lastEventId).toBe('e2');

    // Hard failure after having been open: reconnect with backoff and resume from e2.
    es.fail();
    expect(es.closed).toBe(true);
    expect(client.status).toBe('error');
    vi.advanceTimersByTime(99);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('lastEventId=e2');

    // Browser-managed reconnect (readyState CONNECTING) only changes the status.
    FakeEventSource.instances[1]!.open();
    FakeEventSource.instances[1]!.blip();
    expect(client.status).toBe('connecting');
    expect(FakeEventSource.instances).toHaveLength(2);

    client.close();
    expect(client.status).toBe('closed');
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('falls back to polling when the first subscription attempt is answered with 503', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: 'live_unavailable', transport: 'polling', pollIntervalMs: 2000 }, 503),
      )
      .mockResolvedValueOnce(
        jsonResponse({ channel: 'room', events: [ev('p1')], cursor: 'p1', transport: 'none' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ channel: 'room', events: [ev('p2')], cursor: 'p2', transport: 'none' }),
      );
    const client = make();
    client.connect();
    FakeEventSource.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.transport).toBe('polling');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://app.test/_hypdriv/live/room/events');
    expect(client.status).toBe('open');
    expect(received.map((e) => e.id)).toEqual(['p1']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toBe('https://app.test/_hypdriv/live/room/events?after=p1');
    expect(received.map((e) => e.id)).toEqual(['p1', 'p2']);
    client.close();
  });

  it('polls a custom pollUrl, honours retry-after and backs off on errors', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ events: [], cursor: 'c0' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '3' }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ events: [ev('x1')], cursor: 'x1' }))
      .mockResolvedValue(jsonResponse({ events: [], cursor: 'x1' }));
    const client = make({
      transport: 'polling',
      pollUrl: '/api/feed',
      pollIntervalMs: 1000,
      reconnect: { baseMs: 100, maxMs: 10_000, jitter: false },
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://app.test/api/feed');
    expect(client.status).toBe('open');
    expect(client.lastEventId).toBe('c0');
    // regular interval → 429 with retry-after: 3 → next poll after 3 s
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.status).toBe('error');
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // rejected → exponential backoff (attempt 2 → 4 s)
    expect(client.status).toBe('error');
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(received.map((e) => e.id)).toEqual(['x1']);
    expect(client.status).toBe('open');
    expect(String(fetchMock.mock.calls[3]![0])).toBe('https://app.test/api/feed?after=c0');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]![0])).toBe('https://app.test/api/feed?after=x1');
    client.close();
  });

  it('supports WebSockets with keep-alive pings, control frames and 1013 handling', () => {
    const client = make({ transport: 'websocket', pingIntervalMs: 500 });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://app.test/_hypdriv/live/room?transport=websocket');
    ws.open();
    expect(client.status).toBe('open');
    expect(client.transport).toBe('websocket');
    vi.advanceTimersByTime(500);
    expect(ws.sent).toEqual(['{"type":"ping"}']);
    ws.emit({ type: 'pong' });
    ws.emit(ev('w1'));
    expect(received.map((e) => e.id)).toEqual(['w1']);

    ws.close(1013, 'too many subscribers');
    expect(client.status).toBe('error');
    vi.advanceTimersByTime(4999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toContain('lastEventId=w1');
    client.close();
    expect(FakeWebSocket.instances[1]!.readyState).toBe(3);
  });

  it('switches from WebSocket to polling when the server reports transport none', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ channel: 'room', events: [], cursor: null, transport: 'none' }),
    );
    const client = make();
    client.connect();
    // no EventSource support → WebSocket
    client.close();
    const noEs = createLiveClient({
      channel: 'room',
      origin: 'https://app.test',
      fetch: fetchMock,
      EventSource: undefined,
      WebSocket: FakeWebSocket,
      reconnect: { baseMs: 100, maxMs: 1000, jitter: false },
      onStatus: (status, info) => statuses.push({ status, transport: info.transport }),
    });
    noEs.connect();
    expect(noEs.transport).toBe('websocket');
    FakeWebSocket.instances.at(-1)!.close(1006, '');
    await vi.advanceTimersByTimeAsync(0);
    expect(noEs.transport).toBe('polling');
    noEs.close();
  });

  it('filters by type without losing the resume cursor', () => {
    const client = make({ types: ['keep'] });
    client.connect();
    const es = FakeEventSource.instances[0]!;
    es.open();
    es.emit(ev('a', 'drop'));
    es.emit(ev('b', 'keep'));
    es.emit(ev('c', 'drop'));
    expect(received.map((e) => e.id)).toEqual(['b']);
    expect(client.lastEventId).toBe('c');
    client.close();
  });

  it('connect is idempotent and close is final', () => {
    const client = make();
    client.connect();
    client.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    client.close();
    client.close();
    client.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(statuses.filter((s) => s.status === 'closed')).toHaveLength(1);
  });
});

describe('parseSse', () => {
  it('parses complete frames and returns the partial remainder', () => {
    const text = `retry: 3000\n\n: hello\n\nid: a\ndata: ${JSON.stringify(ev('a'))}\n\nid: b\ndata: {"id":"b","ty`;
    const { events, rest } = parseSse(text);
    expect(events.map((e) => e.id)).toEqual(['a']);
    expect(rest).toBe('id: b\ndata: {"id":"b","ty');
    expect(parseSse('data: not json\n\n').events).toEqual([]);
    expect(parseSse('data: {"id":"x"}\n\n').events).toEqual([]);
  });
});

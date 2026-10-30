import { DurableObject } from 'cloudflare:workers';
import { uuidv7 } from '@hypdriv/core';
import {
  DEFAULT_MAX_SUBSCRIBERS,
  DEFAULT_RETAIN,
  formatSseComment,
  formatSseEvent,
  formatSseRetry,
  HEARTBEAT_MS,
  LIVE_DO_PATHS,
  LIVE_HEADERS,
  type LiveChannelStats,
  type LiveEvent,
  type LiveEventsResponse,
  type LivePublishResponse,
  MAX_EVENT_BYTES,
  MAX_EVENTS_PER_PAGE,
  SSE_RETRY_MS,
} from '../protocol';

type EventRow = Record<string, SqlStorageValue> & {
  id: string;
  seq: number;
  type: string;
  data: string | null;
  ts: number;
};

interface SseSubscriber {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

const encoder = new TextEncoder();
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

/**
 * One Durable Object per channel name (`idFromName(channel)`): pub/sub with SQLite-backed replay.
 *
 * - `POST /publish` `{ type, data?, id? }` assigns a sequence number and a UUIDv7 id, stores the event,
 *   trims the log to the last `retain` events and broadcasts to every WebSocket and SSE subscriber.
 * - `GET /subscribe` with `Upgrade: websocket` accepts the socket through the **Hibernation API**
 *   (`ctx.acceptWebSocket`), replays events after `lastEventId` and answers `{"type":"ping"}` with
 *   `{"type":"pong"}` without waking the object (auto-response). Hibernated sockets cost nothing while idle.
 * - `GET /subscribe` with `Accept: text/event-stream` streams SSE: replay, then live events, with a
 *   heartbeat comment every 25 s. SSE streams are in-memory writers and keep the object awake for their
 *   whole lifetime, so WebSockets are the cheap path at scale; SSE is the zero-setup one.
 * - `GET /events?after=<id|seq>&limit=` returns retained events as JSON for polling clients.
 * - `GET /stats` reports subscriber and event counts. `DELETE` (or `/clear`) empties the log.
 *
 * Limits arrive as request headers from the handler/publisher: `x-hypdriv-live-retain` (default 50)
 * and `x-hypdriv-live-max-subscribers` (default 10000; excess WebSockets are closed with code 1013,
 * excess SSE requests get 503).
 *
 * Wrangler: bind it as `HYPDRIV_CHANNEL` with a `new_sqlite_classes: ["HypDrivChannel"]` migration.
 */
export class HypDrivChannel extends DurableObject {
  private readonly sse = new Map<number, SseSubscriber>();
  private nextSseId = 1;
  private seq = 0;
  private retain = DEFAULT_RETAIN;
  private maxSubscribers = DEFAULT_MAX_SUBSCRIBERS;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT, ts INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS events_seq ON events (seq)');
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
      .one();
    this.seq = Number(row.seq ?? 0);
    try {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    } catch {
      // older runtimes without auto-response: webSocketMessage handles pings
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const channel = request.headers.get(LIVE_HEADERS.channel) ?? url.searchParams.get('channel') ?? 'default';
    this.applyLimits(request.headers);

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket(request, url, channel);
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'DELETE' || path === LIVE_DO_PATHS.clear) return this.handleClear(channel);
    if (request.method === 'POST' && path === LIVE_DO_PATHS.publish)
      return this.handlePublish(request, channel);
    if (request.method === 'GET' && path === LIVE_DO_PATHS.events) return this.handleEvents(url, channel);
    if (request.method === 'GET' && path === LIVE_DO_PATHS.stats) return this.handleStats(channel);
    if (
      request.method === 'GET' &&
      (path === LIVE_DO_PATHS.subscribe ||
        (request.headers.get('accept') ?? '').includes('text/event-stream'))
    ) {
      return this.handleSse(request, url, channel);
    }
    return json({ error: 'not_found' }, 404);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const frame = parsed as { type?: unknown; lastEventId?: unknown };
    if (frame.type === 'ping') {
      safeSend(ws, PONG);
    } else if (frame.type === 'resume' && typeof frame.lastEventId === 'string') {
      for (const event of this.eventsAfter(frame.lastEventId, this.retain))
        safeSend(ws, JSON.stringify(event));
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason.slice(0, 120));
    } catch {
      // already closed
    }
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'websocket error');
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------------------

  private applyLimits(headers: Headers): void {
    const retain = Number(headers.get(LIVE_HEADERS.retain));
    if (Number.isFinite(retain) && retain >= 0) this.retain = Math.min(Math.floor(retain), 10_000);
    const max = Number(headers.get(LIVE_HEADERS.maxSubscribers));
    if (Number.isFinite(max) && max > 0) this.maxSubscribers = Math.floor(max);
  }

  private subscriberCount(): number {
    return this.ctx.getWebSockets().length + this.sse.size;
  }

  private handleWebSocket(request: Request, url: URL, channel: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (this.subscriberCount() >= this.maxSubscribers) {
      server.accept();
      server.close(1013, 'too many subscribers');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, [channel]);
    server.serializeAttachment({ channel, since: Date.now() });
    const lastEventId = url.searchParams.get('lastEventId') ?? request.headers.get('last-event-id');
    if (lastEventId) {
      for (const event of this.eventsAfter(lastEventId, this.retain)) safeSend(server, JSON.stringify(event));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSse(request: Request, url: URL, channel: string): Promise<Response> {
    if (this.subscriberCount() >= this.maxSubscribers) {
      return json({ error: 'too_many_subscribers', channel }, 503, { 'retry-after': '10' });
    }
    const Identity =
      (globalThis as { IdentityTransformStream?: typeof TransformStream }).IdentityTransformStream ??
      TransformStream;
    const { readable, writable } = new Identity<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const id = this.nextSseId++;

    let intro = formatSseRetry(SSE_RETRY_MS) + formatSseComment(`hypdriv live ${channel}`);
    const lastEventId = url.searchParams.get('lastEventId') ?? request.headers.get('last-event-id');
    if (lastEventId)
      for (const event of this.eventsAfter(lastEventId, this.retain)) intro += formatSseEvent(event);

    const heartbeat = setInterval(() => {
      writer.write(encoder.encode(formatSseComment('ping'))).catch(() => this.dropSse(id));
    }, HEARTBEAT_MS);
    this.sse.set(id, { writer, heartbeat });
    writer.closed.catch(() => this.dropSse(id));
    try {
      request.signal.addEventListener('abort', () => this.dropSse(id), { once: true });
    } catch {
      // signal not available on this runtime; write failures still clean up
    }
    writer.write(encoder.encode(intro)).catch(() => this.dropSse(id));

    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, no-transform',
        'x-accel-buffering': 'no',
        [LIVE_HEADERS.transport]: 'sse',
        [LIVE_HEADERS.channel]: channel,
      },
    });
  }

  private dropSse(id: number): void {
    const sub = this.sse.get(id);
    if (!sub) return;
    this.sse.delete(id);
    clearInterval(sub.heartbeat);
    sub.writer.close().catch(() => undefined);
  }

  private async handlePublish(request: Request, channel: string): Promise<Response> {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES)
      return json({ error: 'payload_too_large' }, 413);
    const text = await request.text();
    if (text.length > MAX_EVENT_BYTES) return json({ error: 'payload_too_large' }, 413);
    let body: { type?: unknown; data?: unknown; id?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.type !== 'string' ||
      !body.type ||
      body.type.length > 128
    ) {
      return json({ error: 'invalid_event', detail: '`type` must be a string of 1–128 characters' }, 400);
    }
    if (body.id !== undefined && (typeof body.id !== 'string' || !body.id || body.id.length > 128)) {
      return json({ error: 'invalid_event', detail: '`id` must be a string of 1–128 characters' }, 400);
    }
    const event: LiveEvent = {
      id: typeof body.id === 'string' ? body.id : uuidv7(),
      type: body.type,
      data: body.data === undefined ? null : body.data,
      ts: Date.now(),
    };
    const seq = ++this.seq;
    const sql = this.ctx.storage.sql;
    sql.exec(
      'INSERT OR REPLACE INTO events (id, seq, type, data, ts) VALUES (?, ?, ?, ?, ?)',
      event.id,
      seq,
      event.type,
      JSON.stringify(event.data),
      event.ts,
    );
    if (this.retain === 0) sql.exec('DELETE FROM events');
    else sql.exec('DELETE FROM events WHERE seq <= ?', seq - this.retain);
    this.broadcast(event);
    const response: LivePublishResponse = { ok: true, event, seq, subscribers: this.subscriberCount() };
    return json(response, 200, { [LIVE_HEADERS.channel]: channel });
  }

  private handleEvents(url: URL, channel: string): Response {
    const after = url.searchParams.get('after') ?? url.searchParams.get('lastEventId');
    const limitParam = Number(url.searchParams.get('limit'));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), MAX_EVENTS_PER_PAGE)
        : Math.min(Math.max(this.retain, 1), MAX_EVENTS_PER_PAGE);
    const events = after ? this.eventsAfter(after, limit) : this.latest(limit);
    const last = events.at(-1);
    const body: LiveEventsResponse = {
      channel,
      events,
      cursor: last?.id ?? after ?? this.lastId(),
      transport: 'durable-object',
    };
    return json(body, 200, { 'cache-control': 'no-store', [LIVE_HEADERS.transport]: 'durable-object' });
  }

  private handleStats(channel: string): Response {
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events').one();
    const body: LiveChannelStats = {
      channel,
      subscribers: { websocket: this.ctx.getWebSockets().length, sse: this.sse.size },
      events: Number(count.n ?? 0),
      seq: this.seq,
      lastId: this.lastId(),
    };
    return json(body, 200, { 'cache-control': 'no-store' });
  }

  private handleClear(channel: string): Response {
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events').one();
    this.ctx.storage.sql.exec('DELETE FROM events');
    return json({ ok: true, channel, cleared: Number(count.n ?? 0) });
  }

  private broadcast(event: LiveEvent): void {
    const frame = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (!safeSend(ws, frame)) {
        try {
          ws.close(1011, 'send failed');
        } catch {
          // ignore
        }
      }
    }
    if (this.sse.size === 0) return;
    const bytes = encoder.encode(formatSseEvent(event));
    for (const [id, sub] of this.sse) {
      sub.writer.write(bytes).catch(() => this.dropSse(id));
    }
  }

  private lastId(): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>('SELECT id FROM events ORDER BY seq DESC LIMIT 1')
      .toArray();
    return rows[0]?.id ?? null;
  }

  private latest(limit: number): LiveEvent[] {
    const rows = this.ctx.storage.sql
      .exec<EventRow>('SELECT id, seq, type, data, ts FROM events ORDER BY seq DESC LIMIT ?', limit)
      .toArray();
    return rows.reverse().map(rowToEvent);
  }

  /** Events strictly after `after`, which is a sequence number or an event id. */
  private eventsAfter(after: string, limit: number): LiveEvent[] {
    const sql = this.ctx.storage.sql;
    let rows: EventRow[];
    if (/^\d{1,15}$/.test(after)) {
      rows = sql
        .exec<EventRow>(
          'SELECT id, seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
          Number(after),
          limit,
        )
        .toArray();
    } else {
      const known = sql.exec<{ seq: number }>('SELECT seq FROM events WHERE id = ?', after).toArray();
      rows = known[0]
        ? sql
            .exec<EventRow>(
              'SELECT id, seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
              known[0].seq,
              limit,
            )
            .toArray()
        : // Unknown (expired) id: UUIDv7 ids sort by time, so string comparison is the best approximation.
          sql
            .exec<EventRow>(
              'SELECT id, seq, type, data, ts FROM events WHERE id > ? ORDER BY seq ASC LIMIT ?',
              after,
              limit,
            )
            .toArray();
    }
    return rows.map(rowToEvent);
  }
}

function rowToEvent(row: EventRow): LiveEvent {
  let data: unknown = null;
  if (row.data !== null && row.data !== undefined) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = row.data;
    }
  }
  return { id: row.id, type: row.type, data, ts: Number(row.ts) };
}

function safeSend(ws: WebSocket, frame: string): boolean {
  try {
    ws.send(frame);
    return true;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

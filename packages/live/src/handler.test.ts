import { type DurableObjectNamespaceLike, type DurableObjectStubLike, resolveConfig } from '@hypdriv/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveHandler, parseLivePath } from './handler';
import { LIVE_HEADERS, type LiveEventsResponse } from './protocol';
import { clearChannel, createPublisher, publish, resetLiveWarnings } from './publish';

interface RecordedFetch {
  id: string;
  request: Request;
}

/** Minimal fake namespace: one memoised stub per id that records fetches and answers from `respond`. */
function fakeNamespace(
  respond: (request: Request, id: string) => Response | Promise<Response> = () => new Response('ok'),
) {
  const stubs = new Map<string, DurableObjectStubLike>();
  const fetches: RecordedFetch[] = [];
  const ns: DurableObjectNamespaceLike & { fetches: RecordedFetch[] } = {
    fetches,
    idFromName: (name) => ({ toString: () => `id:${name}`, name }),
    get(id) {
      const key = id.toString();
      let stub = stubs.get(key);
      if (!stub) {
        stub = {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const request = input instanceof Request && !init ? input : new Request(input, init);
            fetches.push({ id: key, request });
            return respond(request, key);
          },
        };
        stubs.set(key, stub);
      }
      return stub;
    },
  };
  return ns;
}

const config = resolveConfig({});

describe('parseLivePath', () => {
  it('extracts channel and action', () => {
    expect(parseLivePath('/_hypdriv/live/orders', '/_hypdriv/live')).toEqual({
      channel: 'orders',
      action: 'subscribe',
    });
    expect(parseLivePath('/_hypdriv/live/orders/events/', '/_hypdriv/live')).toEqual({
      channel: 'orders',
      action: 'events',
    });
    expect(parseLivePath('/_hypdriv/live/a%3Ab/stats', '/_hypdriv/live/')).toEqual({
      channel: 'a:b',
      action: 'stats',
    });
    expect(parseLivePath('/_hypdriv/live/orders/x', '/_hypdriv/live')).toEqual({
      channel: 'orders',
      action: 'unknown',
    });
    expect(parseLivePath('/_hypdriv/live/a/events/b', '/_hypdriv/live')).toEqual({
      channel: 'a',
      action: 'unknown',
    });
    expect(parseLivePath('/_hypdriv/live', '/_hypdriv/live')).toBeNull();
    expect(parseLivePath('/_hypdriv/live/', '/_hypdriv/live')).toBeNull();
    expect(parseLivePath('/other/x', '/_hypdriv/live')).toBeNull();
  });
});

describe('createLiveHandler with a Durable Object binding', () => {
  it('forwards subscriptions to idFromName(channel) with limit headers and SSE accept', async () => {
    const ns = fakeNamespace(
      () => new Response('stream', { headers: { 'content-type': 'text/event-stream' } }),
    );
    const handler = createLiveHandler(resolveConfig({ live: { retain: 7, maxSubscribers: 42 } }), {
      HYPDRIV_CHANNEL: ns,
    });
    const res = await handler(
      new Request('https://app.test/_hypdriv/live/orders?lastEventId=abc', { headers: { cookie: 'a=b' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(ns.fetches).toHaveLength(1);
    const forwarded = ns.fetches[0]!;
    expect(forwarded.id).toBe('id:orders');
    const url = new URL(forwarded.request.url);
    expect(url.origin).toBe('https://hypdriv.live');
    expect(url.pathname).toBe('/subscribe');
    expect(url.searchParams.get('channel')).toBe('orders');
    expect(url.searchParams.get('lastEventId')).toBe('abc');
    expect(url.searchParams.get('transport')).toBe('sse');
    expect(forwarded.request.headers.get(LIVE_HEADERS.channel)).toBe('orders');
    expect(forwarded.request.headers.get(LIVE_HEADERS.retain)).toBe('7');
    expect(forwarded.request.headers.get(LIVE_HEADERS.maxSubscribers)).toBe('42');
    expect(forwarded.request.headers.get('accept')).toBe('text/event-stream');
    expect(forwarded.request.headers.get('cookie')).toBe('a=b');
  });

  it('keeps the websocket upgrade header and maps events/stats paths', async () => {
    const ns = fakeNamespace((req) =>
      Response.json({ path: new URL(req.url).pathname, upgrade: req.headers.get('upgrade') }),
    );
    const handler = createLiveHandler(config, { HYPDRIV_CHANNEL: ns });
    const ws = await (
      await handler(new Request('https://app.test/_hypdriv/live/room', { headers: { upgrade: 'websocket' } }))
    ).json();
    expect(ws).toEqual({ path: '/subscribe', upgrade: 'websocket' });
    expect(new URL(ns.fetches[0]!.request.url).searchParams.get('transport')).toBeNull();
    const events = await (
      await handler(new Request('https://app.test/_hypdriv/live/room/events?after=5&limit=2'))
    ).json();
    expect(events).toEqual({ path: '/events', upgrade: null });
    expect(new URL(ns.fetches[1]!.request.url).searchParams.get('after')).toBe('5');
    const stats = await (await handler(new Request('https://app.test/_hypdriv/live/room/stats'))).json();
    expect(stats).toEqual({ path: '/stats', upgrade: null });
    expect(ns.fetches.every((f) => f.id === 'id:room')).toBe(true);
  });

  it('uses the configured binding name and path', async () => {
    const ns = fakeNamespace();
    const handler = createLiveHandler(resolveConfig({ live: { binding: 'CHAN', path: '/realtime' } }), {
      CHAN: ns,
    });
    expect((await handler(new Request('https://app.test/realtime/x/events'))).status).toBe(200);
    expect(ns.fetches).toHaveLength(1);
    expect((await handler(new Request('https://app.test/_hypdriv/live/x/events'))).status).toBe(404);
  });

  it('rejects invalid channel names, unknown actions, writes and disabled config', async () => {
    const ns = fakeNamespace();
    const handler = createLiveHandler(config, { HYPDRIV_CHANNEL: ns });
    expect((await handler(new Request('https://app.test/_hypdriv/live/bad%20name'))).status).toBe(400);
    expect((await handler(new Request(`https://app.test/_hypdriv/live/${'a'.repeat(129)}`))).status).toBe(
      400,
    );
    expect((await handler(new Request('https://app.test/_hypdriv/live/ok/unknown'))).status).toBe(404);
    const post = await handler(new Request('https://app.test/_hypdriv/live/ok', { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(
      (await handler(new Request('https://app.test/_hypdriv/live/ok', { method: 'DELETE' }))).status,
    ).toBe(405);
    expect(ns.fetches).toHaveLength(0);
    const disabled = createLiveHandler(resolveConfig({ live: { enabled: false } }), { HYPDRIV_CHANNEL: ns });
    expect((await disabled(new Request('https://app.test/_hypdriv/live/ok'))).status).toBe(404);
  });

  it('authorises with config.live.authorize and a per-request override', async () => {
    const ns = fakeNamespace();
    const seen: string[] = [];
    const cfg = resolveConfig({
      live: {
        authorize: ({ channel, headers }) => {
          seen.push(channel);
          return headers.get('authorization') === 'Bearer ok';
        },
      },
    });
    const handler = createLiveHandler(cfg, { HYPDRIV_CHANNEL: ns });
    const denied = await handler(new Request('https://app.test/_hypdriv/live/private/events'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', channel: 'private' });
    const allowed = await handler(
      new Request('https://app.test/_hypdriv/live/private/events', {
        headers: { authorization: 'Bearer ok' },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(seen).toEqual(['private', 'private']);
    const overridden = await handler(new Request('https://app.test/_hypdriv/live/private/events'), {
      authorize: async () => true,
    });
    expect(overridden.status).toBe(200);
    const throwing = await handler(new Request('https://app.test/_hypdriv/live/private/events'), {
      authorize: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.status).toBe(403);
  });
});

describe('createLiveHandler without a binding (polling fallback)', () => {
  const handler = createLiveHandler(resolveConfig({ live: { pollInterval: '7s' } }), {});

  it('answers subscriptions with 503 live_unavailable', async () => {
    const sse = await handler(
      new Request('https://app.test/_hypdriv/live/orders', { headers: { accept: 'text/event-stream' } }),
    );
    expect(sse.status).toBe(503);
    expect(sse.headers.get('retry-after')).toBe('7');
    expect(await sse.json()).toEqual({
      error: 'live_unavailable',
      transport: 'polling',
      pollIntervalMs: 7000,
    });
    const ws = await handler(
      new Request('https://app.test/_hypdriv/live/orders', { headers: { upgrade: 'websocket' } }),
    );
    expect(ws.status).toBe(503);
  });

  it('answers /events with an empty list and transport none', async () => {
    const res = await handler(new Request('https://app.test/_hypdriv/live/orders/events?after=x'));
    expect(res.status).toBe(200);
    expect(res.headers.get(LIVE_HEADERS.transport)).toBe('none');
    const body = (await res.json()) as LiveEventsResponse;
    expect(body).toEqual({ channel: 'orders', events: [], cursor: null, transport: 'none' });
    const stats = await (await handler(new Request('https://app.test/_hypdriv/live/orders/stats'))).json();
    expect(stats).toMatchObject({ transport: 'none' });
  });

  it('ignores bindings that are not namespaces', async () => {
    const h = createLiveHandler(config, { HYPDRIV_CHANNEL: { get: 1 } });
    expect(
      (await h(new Request('https://app.test/_hypdriv/live/x', { headers: { accept: 'text/event-stream' } })))
        .status,
    ).toBe(503);
  });
});

describe('publish', () => {
  afterEach(() => {
    resetLiveWarnings();
    vi.restoreAllMocks();
  });

  it('posts to the channel stub and returns the stored event', async () => {
    const ns = fakeNamespace(async (req) => {
      const body = (await req.json()) as { type: string; data: unknown; id?: string };
      return Response.json({
        ok: true,
        event: { id: body.id ?? 'gen', type: body.type, data: body.data, ts: 1 },
        seq: 3,
        subscribers: 2,
      });
    });
    const result = await publish(
      { HYPDRIV_CHANNEL: ns },
      'orders',
      { type: 'created', data: { id: 7 } },
      { retain: 9 },
    );
    expect(result).toEqual({
      delivered: true,
      transport: 'durable-object',
      event: { id: 'gen', type: 'created', data: { id: 7 }, ts: 1 },
      subscribers: 2,
    });
    const req = ns.fetches[0]!.request;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/publish');
    expect(req.headers.get(LIVE_HEADERS.retain)).toBe('9');
    expect(req.headers.get(LIVE_HEADERS.channel)).toBe('orders');
    const custom = await publish({ HYPDRIV_CHANNEL: ns }, 'orders', { type: 'x', id: 'my-id' });
    expect(custom.event?.id).toBe('my-id');
  });

  it('returns delivered:false and warns once when the binding is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await publish({}, 'orders', { type: 'created' })).toEqual({ delivered: false, transport: 'none' });
    expect(await publish(undefined, 'orders', { type: 'created' })).toEqual({
      delivered: false,
      transport: 'none',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('HYPDRIV_CHANNEL');
  });

  it('reports invalid input and upstream failures without throwing', async () => {
    expect((await publish({}, 'bad name', { type: 'x' })).error).toContain('invalid channel');
    expect((await publish({}, 'ok', { type: '' })).error).toContain('event.type');
    const failing = fakeNamespace(() => new Response('nope', { status: 500 }));
    const failed = await publish({ HYPDRIV_CHANNEL: failing }, 'ok', { type: 'x' });
    expect(failed).toMatchObject({ delivered: false, transport: 'durable-object' });
    expect(failed.error).toContain('500');
    const throwing = fakeNamespace(() => {
      throw new Error('network');
    });
    expect((await publish({ HYPDRIV_CHANNEL: throwing }, 'ok', { type: 'x' })).error).toBe('network');
  });

  it('createPublisher binds env and options; clearChannel issues DELETE', async () => {
    const ns = fakeNamespace((req) =>
      req.method === 'DELETE'
        ? Response.json({ ok: true, cleared: 4 })
        : Response.json({
            ok: true,
            event: { id: '1', type: 't', data: null, ts: 0 },
            seq: 1,
            subscribers: 0,
          }),
    );
    const live = createPublisher({ CHAN: ns }, { binding: 'CHAN' });
    expect((await live('a', { type: 't' })).delivered).toBe(true);
    expect(await clearChannel({ CHAN: ns }, 'a', { binding: 'CHAN' })).toEqual({
      cleared: 4,
      transport: 'durable-object',
    });
    expect(await clearChannel({}, 'a')).toEqual({ cleared: 0, transport: 'none' });
    expect(ns.fetches.map((f) => f.request.method)).toEqual(['POST', 'DELETE']);
  });
});

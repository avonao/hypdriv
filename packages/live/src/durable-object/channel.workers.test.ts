import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_HEADERS, type LiveEvent, type LiveEventsResponse, parseSse } from '../protocol';
import { clearChannel, publish } from '../publish';
import type { HypDrivChannel } from './index';

interface TestEnv {
  HYPDRIV_CHANNEL: DurableObjectNamespace<HypDrivChannel>;
}
const testEnv = env as unknown as TestEnv & Record<string, unknown>;

let counter = 0;
const channelName = () => `test-${Date.now().toString(36)}-${counter++}`;

async function readSse(response: Response, options: { minEvents?: number; timeoutMs?: number } = {}) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events: LiveEvent[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    const parsed = parseSse(text);
    events.length = 0;
    events.push(...parsed.events);
    if (events.length >= (options.minEvents ?? 1)) break;
  }
  await reader.cancel().catch(() => undefined);
  return { text, events };
}

afterEach(() => {
  // nothing shared between tests: every test uses its own channel name
});

describe('HypDrivChannel (workerd)', () => {
  it('publish() stores the event and /events returns it for polling clients', async () => {
    const channel = channelName();
    const result = await publish(testEnv, channel, { type: 'greeting', data: { hello: 'world' } });
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('durable-object');
    expect(result.event?.type).toBe('greeting');
    expect(result.event?.id).toMatch(/^[0-9a-f-]{36}$/);

    const res = await SELF.fetch(`https://app.test/_hypdriv/live/${channel}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get(LIVE_HEADERS.transport)).toBe('durable-object');
    const body = (await res.json()) as LiveEventsResponse;
    expect(body.transport).toBe('durable-object');
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      id: result.event!.id,
      type: 'greeting',
      data: { hello: 'world' },
    });
    expect(body.cursor).toBe(result.event!.id);

    const after = (await (
      await SELF.fetch(`https://app.test/_hypdriv/live/${channel}/events?after=${body.cursor}`)
    ).json()) as LiveEventsResponse;
    expect(after.events).toEqual([]);
    expect(after.cursor).toBe(body.cursor);
  });

  it('replays after a sequence number or an expired id and trims to retain', async () => {
    const channel = channelName();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await publish(testEnv, channel, { type: 'tick', data: i }, { retain: 5 });
      ids.push(r.event!.id);
    }
    const all = (await (
      await SELF.fetch(`https://app.test/_hypdriv/live/${channel}/events`)
    ).json()) as LiveEventsResponse;
    expect(all.events.map((e) => e.data)).toEqual([3, 4, 5, 6, 7]);
    const bySeq = (await (
      await SELF.fetch(`https://app.test/_hypdriv/live/${channel}/events?after=6`)
    ).json()) as LiveEventsResponse;
    expect(bySeq.events.map((e) => e.data)).toEqual([6, 7]);
    // ids[0] was trimmed: string ordering of UUIDv7 still yields everything newer.
    const expired = (await (
      await SELF.fetch(`https://app.test/_hypdriv/live/${channel}/events?after=${ids[0]}`)
    ).json()) as LiveEventsResponse;
    expect(expired.events.map((e) => e.data)).toEqual([3, 4, 5, 6, 7]);

    const stub = testEnv.HYPDRIV_CHANNEL.get(testEnv.HYPDRIV_CHANNEL.idFromName(channel));
    const rows = await runInDurableObject(stub, (_instance, state) => {
      return state.storage.sql.exec('SELECT COUNT(*) AS n FROM events').one().n;
    });
    expect(rows).toBe(5);
  });

  it('streams SSE with a retry hint, replay and live events', async () => {
    const channel = channelName();
    const first = await publish(testEnv, channel, { type: 'first', data: 1 });
    const res = await SELF.fetch(`https://app.test/_hypdriv/live/${channel}?lastEventId=0`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get(LIVE_HEADERS.transport)).toBe('sse');

    const publishing = publish(testEnv, channel, { type: 'second', data: 2 });
    const { text, events } = await readSse(res, { minEvents: 2 });
    await publishing;
    expect(text.startsWith('retry: 3000\n\n')).toBe(true);
    expect(text).toContain(`id: ${first.event!.id}\n`);
    expect(events.map((e) => e.type)).toEqual(['first', 'second']);
  });

  it('serves WebSockets through the hibernation API with replay and ping/pong', async () => {
    const channel = channelName();
    const seeded = await publish(testEnv, channel, { type: 'seed', data: 'a' });
    const res = await SELF.fetch(`https://app.test/_hypdriv/live/${channel}?lastEventId=0`, {
      headers: { upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    expect(ws).toBeTruthy();
    const frames: string[] = [];
    const waitFor = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${count} frames, got ${frames.length}`)),
          3000,
        );
        const check = () => {
          if (frames.length >= count) {
            clearTimeout(timer);
            resolve();
          }
        };
        ws.addEventListener('message', (ev) => {
          frames.push(String(ev.data));
          check();
        });
        check();
      });
    ws.accept();
    const ready = waitFor(1);
    await ready;
    expect(JSON.parse(frames[0]!)).toMatchObject({ id: seeded.event!.id, type: 'seed' });

    ws.send('{"type":"ping"}');
    const live = publish(testEnv, channel, { type: 'live', data: 'b' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frames')), 3000);
      const check = () => {
        const types = frames.map((f) => JSON.parse(f).type);
        if (types.includes('pong') && types.includes('live')) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.addEventListener('message', check);
      check();
    });
    await live;
    const types = frames.map((f) => JSON.parse(f).type);
    expect(types).toContain('pong');
    expect(types).toContain('live');
    ws.close(1000, 'done');
  });

  it('enforces the subscriber cap (503 for SSE, 1013 for WebSockets)', async () => {
    const channel = channelName();
    const stub = testEnv.HYPDRIV_CHANNEL.get(testEnv.HYPDRIV_CHANNEL.idFromName(channel));
    const open = await stub.fetch(`https://hypdriv.live/subscribe?channel=${channel}`, {
      headers: { accept: 'text/event-stream', [LIVE_HEADERS.maxSubscribers]: '1' },
    });
    expect(open.status).toBe(200);
    const second = await stub.fetch(`https://hypdriv.live/subscribe?channel=${channel}`, {
      headers: { accept: 'text/event-stream', [LIVE_HEADERS.maxSubscribers]: '1' },
    });
    expect(second.status).toBe(503);
    expect(((await second.json()) as { error: string }).error).toBe('too_many_subscribers');

    const wsRes = await stub.fetch(`https://hypdriv.live/subscribe?channel=${channel}`, {
      headers: { upgrade: 'websocket', [LIVE_HEADERS.maxSubscribers]: '1' },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    ws.accept();
    expect(await closed).toBe(1013);
    await open.body?.cancel();
  });

  it('validates publish bodies, reports stats and clears the log', async () => {
    const channel = channelName();
    const stub = testEnv.HYPDRIV_CHANNEL.get(testEnv.HYPDRIV_CHANNEL.idFromName(channel));
    const bad = await stub.fetch('https://hypdriv.live/publish', { method: 'POST', body: '{"data":1}' });
    expect(bad.status).toBe(400);
    const notJson = await stub.fetch('https://hypdriv.live/publish', { method: 'POST', body: 'nope' });
    expect(notJson.status).toBe(400);
    const tooBig = await stub.fetch('https://hypdriv.live/publish', {
      method: 'POST',
      body: JSON.stringify({ type: 'big', data: 'x'.repeat(200 * 1024) }),
    });
    expect(tooBig.status).toBe(413);
    expect((await stub.fetch('https://hypdriv.live/nope')).status).toBe(404);

    await publish(testEnv, channel, { type: 'a', id: 'custom-1' });
    await publish(testEnv, channel, { type: 'b' });
    const stats = (await (await stub.fetch(`https://hypdriv.live/stats?channel=${channel}`)).json()) as {
      events: number;
      seq: number;
      subscribers: { websocket: number; sse: number };
    };
    expect(stats.events).toBe(2);
    expect(stats.seq).toBe(2);
    expect(stats.subscribers).toEqual({ websocket: 0, sse: 0 });

    const cleared = await clearChannel(testEnv, channel);
    expect(cleared).toEqual({ cleared: 2, transport: 'durable-object' });
    const after = (await (
      await SELF.fetch(`https://app.test/_hypdriv/live/${channel}/events`)
    ).json()) as LiveEventsResponse;
    expect(after.events).toEqual([]);
  });

  it('routes through the handler: validation, 405 for publishing over HTTP', async () => {
    expect((await SELF.fetch('https://app.test/_hypdriv/live/bad%20name/events')).status).toBe(400);
    expect((await SELF.fetch('https://app.test/_hypdriv/live/room/publish', { method: 'POST' })).status).toBe(
      405,
    );
    expect((await SELF.fetch('https://app.test/_hypdriv/live/room/what')).status).toBe(404);
    const viaWorker = await SELF.fetch('https://app.test/publish/room-x', {
      method: 'POST',
      body: JSON.stringify({ type: 'from-worker', data: 1 }),
    });
    expect(((await viaWorker.json()) as { delivered: boolean }).delivered).toBe(true);
  });
});

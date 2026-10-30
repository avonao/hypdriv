# @hypdriv/live

Live channels for [HypDriv](https://github.com/avonao/hypdriv) (ADR 0012): pub/sub per channel on a Durable Object with SQLite replay, **WebSocket hibernation** and **SSE**, a server-side `publish()`, the `useLive()` / `useLiveValue()` / `useLiveRefresh()` React hooks, and a **polling fallback** so applications without Durable Objects still build and run.

## Install

```sh
pnpm add @hypdriv/live @hypdriv/core
```

`react` is an optional peer (hooks only). The Durable Object entry needs `@cloudflare/workers-types` at type-check time.

## Wire it up

```ts
// hypdriv.worker.ts (written by `hypdriv init`)
export { HypDrivChannel } from '@hypdriv/live/durable-object';
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["HypDrivChannel"] }]
}
```

`createWorker` from `@hypdriv/cloudflare` mounts `createLiveHandler(config, env)` under `config.live.path` (`/_hypdriv/live`). Without the binding every API below still works: subscriptions answer `503 { error: 'live_unavailable', transport: 'polling' }`, `publish()` becomes a no-op that logs once, and the hooks poll.

```ts
// hypdriv.config.ts
export default defineConfig({
  live: {
    retain: 50, // events kept per channel for late joiners / resume
    maxSubscribers: 10000, // per channel; WebSockets beyond it close with 1013, SSE gets 503
    authorize: ({ channel, headers }) => channel.startsWith('public:') || hasSession(headers),
  },
});
```

## Publish from server code

```ts
import { publish } from '@hypdriv/live';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function createOrder(input: OrderInput) {
  'use server';
  const order = await db.orders.insert(input);
  const { env } = getCloudflareContext();
  const result = await publish(env, 'orders', { type: 'order.created', data: { id: order.id } });
  // result: { delivered: true, transport: 'durable-object', event: { id, type, data, ts }, subscribers }
  //     or: { delivered: false, transport: 'none' } without the binding
}
```

`publish()` never throws for delivery problems. `createPublisher(env, options)` binds `env` once; `clearChannel(env, channel)` empties a channel's log. Events get a UUIDv7 id (time-ordered) unless you pass `id` (idempotent publishes).

Publishing is **server-side only**: the HTTP handler answers `POST`/`DELETE` with 405.

## Subscribe in the browser

```tsx
'use client';
import { useLive, useLiveRefresh, useLiveValue } from '@hypdriv/live/react';
import { useRouter } from 'next/navigation';

export function OrdersFeed() {
  const { status, events, transport } = useLive<{ id: string }>('orders', {
    onEvent: (e) => console.log(e.type, e.data),
    types: ['order.created'],
  });
  return <p>{status} via {transport}: {events.length} events</p>;
}

export function Visitors() {
  const count = useLiveValue<number>('visitors', 0); // latest event.data
  return <span>{count}</span>;
}

export function AutoRefresh() {
  const router = useRouter();
  useLiveRefresh('orders', router.refresh, { debounceMs: 200 }); // server components re-render on publish
  return null;
}
```

Options: `transport: 'auto' | 'sse' | 'websocket' | 'polling'` (auto = SSE, then WebSocket, then polling), `path`, `enabled`, `pollIntervalMs`, `lastEventId` (resume), `pollUrl` (your own endpoint answering `{ events, cursor }`), `types`, `maxEvents`. `LiveProvider` sets `path`/`transport`/`pollIntervalMs` defaults for a subtree. All hooks are SSR-safe: nothing connects until the effect runs in the browser.

`createLiveClient()` is the framework-free connection manager behind the hooks (reconnect with exponential backoff, resume from the last id, duplicate filtering after replays, automatic switch to polling on 503, keep-alive pings over WebSocket).

## Protocol

| Request | Answer |
| --- | --- |
| `GET /_hypdriv/live/<channel>` + `Accept: text/event-stream` | SSE: `retry: 3000`, replay of events after `?lastEventId=` / `Last-Event-ID`, then live events, heartbeat comment every 25 s. Frames are `id: <id>` + `data: <LiveEvent JSON>`. |
| `GET /_hypdriv/live/<channel>` + `Upgrade: websocket` | WebSocket (hibernation API). Frames are `LiveEvent` JSON; `{"type":"ping"}` → `{"type":"pong"}` is answered without waking the object; `{"type":"resume","lastEventId"}` replays. |
| `GET /_hypdriv/live/<channel>/events?after=<id\|seq>&limit=` | `{ channel, events, cursor, transport }` for polling clients (`transport: 'none'` and `events: []` without the binding). |
| `GET /_hypdriv/live/<channel>/stats` | subscriber and event counts. |

`LiveEvent` is `{ id, type, data, ts }`. Channel names match `^[a-zA-Z0-9:_-]{1,128}$`. Payloads are capped at 128 KB.

### Cost model

Hibernated WebSockets cost nothing while idle: the object sleeps between messages. SSE streams are in-memory writers and keep the object awake for their whole lifetime, so prefer `transport: 'websocket'` for channels with many long-lived subscribers; SSE remains the zero-setup default and works through every proxy.

## Testing

Node tests can use a fake namespace (see `@hypdriv/testing`'s `createFakeDurableObjectNamespace`). The real object runs under `@cloudflare/vitest-plugin`; `src/durable-object/test-worker.ts` shows a minimal `main` Worker that exports the class and routes through the handler.

## API

- `createLiveHandler(config, env)`, `parseLivePath`, `getChannelStub`, `isDurableObjectNamespace`
- `publish(env, channel, event, options?)`, `createPublisher`, `clearChannel`, `resetLiveWarnings`
- `createLiveClient(options)` and types `LiveClient`, `LiveStatus`, `LiveTransport`
- protocol: `LiveEvent`, `LiveEventsResponse`, `LIVE_HEADERS`, `LIVE_DO_PATHS`, `isValidChannelName`, `parseSse`, `formatSseEvent`, defaults
- `@hypdriv/live/react`: `useLive`, `useLiveValue`, `useLiveRefresh`, `LiveProvider`
- `@hypdriv/live/durable-object`: `HypDrivChannel`

## License

MIT

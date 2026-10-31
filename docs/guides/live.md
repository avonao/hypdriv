# Live channels

Next.js has no realtime primitive on serverless platforms. Hypdriv's live channels use a Durable Object (`HypDrivChannel`) per channel with WebSocket hibernation and an SSE endpoint, plus a polling fallback when the binding is missing (ADR 0012).

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }] },
"migrations": [{ "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel"] }]
```

## Publish from the server

```ts
import { hyp, publish } from 'hypdriv/server';

export async function addComment(formData: FormData) {
  'use server';
  const comment = await db.comments.insert(/* … */);
  const { env } = await hyp();
  await publish(env, `post:${comment.postId}`, { type: 'comment', data: comment });
}
```

## Subscribe in the browser

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useLive, useLiveRefresh } from 'hypdriv/client';

export function LiveComments({ postId }: { postId: string }) {
  const router = useRouter();
  useLiveRefresh(`post:${postId}`, () => router.refresh());   // re-render server components on publish
  const { status, events } = useLive(`post:${postId}`);
  return <p>{status} · {events.length} updates</p>;
}
```

`useLive` connects with `EventSource` to `/_hypdriv/live/<channel>` by default (`transport: 'websocket'` for bidirectional), reconnects with backoff and replays missed events via `Last-Event-ID`. Without the binding the endpoint answers `503 live_unavailable` and the hook polls `/_hypdriv/live/<channel>/events` at `pollInterval`.

## Authorisation

```ts
live: { authorize: ({ channel, headers }) => channel.startsWith('public:') || hasSession(headers) }
```

Channels are strings `[a-zA-Z0-9:_-]{1,128}`; events are retained (`retain`, default 50) for late joiners; `maxSubscribers` caps connections per channel.

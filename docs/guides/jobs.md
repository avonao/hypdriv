# Scheduled jobs, queues and email

The Worker shell adds `scheduled`, `queue` and `email` handlers to a Next.js app and dispatches them to ordinary Route Handlers with signed internal requests.

```ts
// hypdriv.config.ts
jobs: {
  cron: {
    digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' },
    cleanup: { cron: '15 3 * * *', path: '/api/jobs/cleanup', timeout: '60s' },
  },
  queues: { emails: { path: '/api/queues/emails', retry: 'failed' } },
  email: { path: '/api/inbound-email' },
}
```

```jsonc
// wrangler.jsonc — triggers must match the cron expressions above (hypdriv doctor --fix syncs them)
"triggers": { "crons": ["0 9 * * 1", "15 3 * * *"] },
"queues": { "consumers": [{ "queue": "emails" }], "producers": [{ "binding": "EMAILS", "queue": "emails" }] }
```

```ts
// app/api/jobs/digest/route.ts
import { jobHandler } from '@hypdriv/next/server';
export const POST = jobHandler({}, async ({ job, cron }) => {
  await sendDigests();
  return { sent: 42 };
});
```

```ts
// app/api/queues/emails/route.ts
export const POST = jobHandler({}, async ({ messages }) => {
  const failed: string[] = [];
  for (const m of messages ?? []) { try { await deliver(m.body); } catch { failed.push(m.id); } }
  return { retry: failed };              // only these messages are retried
});
```

Requests are signed with `HYPDRIV_INTERNAL_SECRET` (HMAC-SHA256 over timestamp, method, path+query and body hash; 5-minute window). `jobHandler` rejects unsigned requests outside development. Run a job manually with `npx hypdriv jobs run digest --url https://www.example.com` (it signs the request with the secret from your environment).

Producing to a queue from app code: `const { env } = await hyp(); await env.EMAILS.send({ to, template })` or `enqueue('emails', body)` from `@hypdriv/cloudflare` (falls back to running the consumer route inline when no queue binding exists).

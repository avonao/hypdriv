import { hyp } from '@hypdriv/tanstack-start/server';
import { createFileRoute } from '@tanstack/react-router';

// A server route (no component): an `endpoint` in the Hypdriv manifest, rate-limited by the `api` policy.
export const Route = createFileRoute('/api/time')({
  server: {
    handlers: {
      GET: () => Response.json({ now: new Date().toISOString(), requestId: hyp()?.requestId ?? null }),
    },
  },
});

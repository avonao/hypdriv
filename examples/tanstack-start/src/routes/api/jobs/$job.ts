import { jobHandler } from '@hypdriv/tanstack-start/server';
import { createFileRoute } from '@tanstack/react-router';

// Only HypDriv's signed job dispatch (Cloudflare `scheduled` / `queue` through the Worker shell, `hypdriv jobs run`)
// and Vercel Cron get through; everything else is rejected before the handler runs.
const runJob = jobHandler({}, async ({ job, cron }) => ({
  job,
  cron: cron ?? null,
  ranAt: new Date().toISOString(),
}));

export const Route = createFileRoute('/api/jobs/$job')({
  server: {
    handlers: {
      GET: ({ request }) => runJob(request),
      POST: ({ request }) => runJob(request),
    },
  },
});

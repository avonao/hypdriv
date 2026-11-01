import { jobHandler } from '@hypdriv/solid-start/server';
import type { APIEvent } from '@solidjs/start/server';

// Only Hypdriv's signed job dispatch (Cloudflare `scheduled` / `queue` through the Worker shell, `hypdriv jobs run`)
// and Vercel Cron get through; everything else is rejected before the handler runs.
const runJob = jobHandler({}, async ({ job, cron }) => ({
  job,
  cron: cron ?? null,
  ranAt: new Date().toISOString(),
}));

export const GET = ({ request }: APIEvent) => runJob(request);
export const POST = ({ request }: APIEvent) => runJob(request);

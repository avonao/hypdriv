import { jobHandler } from '@hypdriv/next/server';

// Invoked by the Worker's `scheduled` handler (cron `0 9 * * 1`, see hypdriv.config.ts) with a signed request.
export const POST = jobHandler({}, async ({ job, cron }) => {
  return { job, cron, sent: 0 };
});

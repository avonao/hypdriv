import { jobHandler } from 'hypdriv/server';
import { marker } from '@/lib/marker';

/** Vercel Cron (`GET` + `Authorization: Bearer $CRON_SECRET`) or a signed `hypdriv jobs run tick`. */
const handler = jobHandler({}, async ({ cron, job }) => {
  marker('cron', { job, cron: cron ?? null });
  return { ticked: true, job, cron: cron ?? null };
});

export const GET = handler;
export const POST = handler;

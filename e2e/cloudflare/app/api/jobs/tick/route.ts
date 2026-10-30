import { jobHandler } from 'hypdriv/server';
import { read, record } from '@/lib/kv';

/** Cron (every minute): the suite checks that ticks keep arriving. */
const handler = jobHandler({}, async ({ cron, job }) => {
  const previous = await read<{ count: number }>('cron:tick');
  await record('cron:tick', { job, cron, at: new Date().toISOString(), count: (previous?.count ?? 0) + 1 });
  return { ticked: true };
});

export const GET = handler;
export const POST = handler;

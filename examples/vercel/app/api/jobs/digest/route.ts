import { jobHandler } from 'hypdriv/server';

// Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET` (vercel.json#crons);
// `hypdriv jobs run digest` signs a request with HYPDRIV_INTERNAL_SECRET instead.
const digest = jobHandler({ job: 'digest' }, async ({ job, cron }) => ({ job, cron, sent: 0 }));

export const GET = digest;
export const POST = digest;

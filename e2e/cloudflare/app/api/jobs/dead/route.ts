import { jobHandler } from 'hypdriv/server';
import { record } from '@/lib/kv';

/** Dead-letter consumer: records what exhausted its retries. */
export const POST = jobHandler({}, async ({ messages = [], job }) => {
  for (const m of messages) {
    const body = m.body as { id: string };
    await record(`dead:${body.id}`, { job, attempts: m.attempts, at: new Date().toISOString() });
  }
  return { dead: messages.length };
});

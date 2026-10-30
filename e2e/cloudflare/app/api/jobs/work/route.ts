import { jobHandler } from 'hypdriv/server';
import { read, record } from '@/lib/kv';

interface Job {
  id: string;
  failTimes?: number;
  always?: boolean;
  enqueuedAt: number;
}

/** Queue consumer: fails a job `failTimes` times (or always) so the suite sees retries and the DLQ. */
const handler = jobHandler({}, async ({ messages = [], job }) => {
  const retry: string[] = [];
  for (const m of messages) {
    const body = m.body as Job;
    const previous = await read<{ attempts: number[] }>(`job:${body.id}`);
    const attempts = [...(previous?.attempts ?? []), m.attempts];
    const fail = body.always === true || m.attempts <= (body.failTimes ?? 0);
    await record(`job:${body.id}`, {
      job,
      attempts,
      status: fail ? 'retrying' : 'done',
      latencyMs: Date.now() - body.enqueuedAt,
    });
    if (fail) retry.push(m.id);
  }
  return { retry };
});

export const POST = handler;

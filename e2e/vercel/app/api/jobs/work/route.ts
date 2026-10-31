import { queueConsumer } from 'hypdriv/vercel';
import config from '@/hypdriv.config';
import { marker } from '@/lib/marker';

interface Job {
  id: string;
  failTimes?: number;
  enqueuedAt: number;
}

/**
 * Vercel Queues consumer of `hypdriv-e2e-jobs` (vercel.json `experimentalTriggers`): fails a job `failTimes`
 * times so the suite sees redelivery with increasing attempts.
 */
export const POST = queueConsumer(
  async ({ job, messages }) => {
    const retry: string[] = [];
    for (const m of messages) {
      const body = m.body as Job;
      const fail = m.attempts <= (body.failTimes ?? 0);
      marker('job', {
        job,
        id: body.id,
        attempt: m.attempts,
        status: fail ? 'retrying' : 'done',
        latencyMs: Date.now() - body.enqueuedAt,
      });
      if (fail) retry.push(m.id);
    }
    return { retry };
  },
  { config },
);

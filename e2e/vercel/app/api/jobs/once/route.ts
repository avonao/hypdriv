import { handleCallback } from '@vercel/queue';
import { toQueueCallback } from 'hypdriv/vercel';
import config from '@/hypdriv.config';
import { marker } from '@/lib/marker';

/**
 * Consumer of `hypdriv-e2e-jobs-once` built on the SDK's own `handleCallback` (`toQueueCallback`). The queue
 * has `retry: 'none'`: a failed message is acknowledged instead of redelivered.
 */
export const POST = handleCallback(
  ...toQueueCallback(
    async ({ job, messages }) => {
      for (const m of messages)
        marker('job', { job, id: (m.body as { id: string }).id, attempt: m.attempts, status: 'failed' });
      return { retry: messages.map((m) => m.id) };
    },
    { config },
  ),
);

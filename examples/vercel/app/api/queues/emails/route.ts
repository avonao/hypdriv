import { queueConsumer } from 'hypdriv/vercel';
import config from '@/hypdriv.config';

// Vercel Queues delivers `transactional-email` messages here (vercel.json `experimentalTriggers`); the
// handler receives the same `{ job, messages }` input as a Cloudflare Queues consumer.
export const POST = queueConsumer(
  async ({ job, messages }) => {
    for (const message of messages) console.info('deliver email', { job, id: message.id });
    return { retry: [] };
  },
  { config },
);

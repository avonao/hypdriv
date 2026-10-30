'use server';

import { enqueue, safeAction } from 'hypdriv/server';
import { z } from 'zod';

const Contact = z.object({
  email: z.email('Enter a valid email address'),
  message: z.string().min(10, 'Tell us a little more').max(2000),
});

export const sendMessage = safeAction({
  name: 'contact',
  input: Contact,
  rateLimit: { key: (ctx) => ctx.ip ?? 'anonymous', limit: 5, window: '10m' },
  async handler({ email, message }) {
    // Vercel Queues when @vercel/queue is registered (instrumentation.ts), else the consumer route inline.
    const { transport } = await enqueue('emails', { to: 'team@example.com', replyTo: email, message });
    return { queued: true, transport };
  },
});

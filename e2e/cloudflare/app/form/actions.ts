'use server';

import { safeAction } from 'hypdriv/server';
import { z } from 'zod';

export const subscribe = safeAction({
  name: 'e2e-subscribe',
  input: z.object({ email: z.email('Enter a valid email address') }),
  rateLimit: { key: (ctx) => ctx.ip ?? 'anonymous', limit: 20, window: '1m' },
  async handler({ email }) {
    return { subscribed: email };
  },
});

'use server';

import { safeAction } from 'hypdriv/server';
import { z } from 'zod';

// Any Standard Schema validator works (Zod, Valibot, ArkType, ...).
const Subscribe = z.object({ email: z.email('Enter a valid email address') });

export const subscribe = safeAction({
  name: 'subscribe',
  input: Subscribe,
  rateLimit: { key: (ctx) => ctx.ip ?? 'anonymous', limit: 5, window: '1m' },
  async handler({ email }) {
    return { subscribed: email };
  },
});

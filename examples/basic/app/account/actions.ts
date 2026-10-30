'use server';

import { safeAction } from '@hypdriv/next/server';

const emailSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'hypdriv-example',
    validate(value: unknown) {
      const email = typeof value === 'object' && value && 'email' in value ? String((value as { email: unknown }).email) : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { issues: [{ message: 'Enter a valid email address', path: ['email'] }] };
      return { value: { email } };
    },
  },
};

export const subscribe = safeAction({
  input: emailSchema,
  rateLimit: { key: (ctx) => ctx.ip ?? 'anonymous', limit: 5, window: '1m' },
  async handler({ email }) {
    return { subscribed: email };
  },
});

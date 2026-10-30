import { jobHandler } from 'hypdriv/server';
import { record } from '@/lib/kv';

/** Inbound email (Email Routing → Worker `email` handler → this route). */
export const POST = jobHandler({}, async ({ request }) => {
  await record('email:last', {
    from: request.headers.get('x-email-from'),
    to: request.headers.get('x-email-to'),
    bytes: (await request.text()).length,
    at: new Date().toISOString(),
  });
  return { received: true };
});

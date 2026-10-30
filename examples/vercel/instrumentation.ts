import { createInstrumentation } from 'hypdriv/instrumentation';
import config from './hypdriv.config';

const hypdriv = createInstrumentation({ config });

export async function register() {
  // Registers config + platform env for helpers that run outside a proxied request (enqueue in Server Actions).
  await hypdriv.register();
  // Vercel Queues for enqueue('emails', …) on Vercel and in `next dev` (the SDK's local mode); elsewhere
  // enqueue() calls the consumer route inline, signed with HYPDRIV_INTERNAL_SECRET.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    (process.env.VERCEL === '1' || process.env.NODE_ENV === 'development')
  ) {
    const { send, handleCallback } = await import('@vercel/queue');
    const { registerVercelSdk } = await import('hypdriv/vercel');
    registerVercelSdk({ queue: { send, handleCallback } });
  }
}

export const onRequestError = hypdriv.onRequestError;

import { createInstrumentation } from 'hypdriv/instrumentation';
import config from './hypdriv.config';

const hypdriv = createInstrumentation({ config });

export async function register() {
  await hypdriv.register();
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ send, handleCallback }, { checkBotId }, { checkRateLimit }, { registerVercelSdk }] =
      await Promise.all([
        import('@vercel/queue'),
        import('botid/server'),
        import('@vercel/firewall'),
        import('hypdriv/vercel'),
      ]);
    // Vercel Queues for enqueue(), BotID for verifyBotId(), WAF rate-limit rules for vercel.firewall.
    registerVercelSdk({ queue: { send, handleCallback }, checkBotId, checkRateLimit });
  }
}

export const onRequestError = hypdriv.onRequestError;

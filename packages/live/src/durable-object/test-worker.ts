/**
 * Minimal Worker used by the Workers-runtime tests (`vitest.workers.config.ts` points `main` here).
 * It exports the Durable Object class and routes live requests through the real handler, exactly like
 * `createWorker` from `@hypdriv/cloudflare` does.
 */
import { resolveConfig } from '@hypdriv/core';
import { createLiveHandler } from '../handler';
import { publish } from '../publish';

export { HypDrivChannel } from './index';

const config = resolveConfig({ live: { retain: 5, maxSubscribers: 2 } });

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/publish/') && request.method === 'POST') {
      const channel = url.pathname.slice('/publish/'.length);
      const body = (await request.json()) as { type: string; data?: unknown; id?: string };
      const result = await publish(env, channel, body, { retain: config.live.retain });
      return Response.json(result);
    }
    if (url.pathname.startsWith(config.live.path)) {
      const handler = createLiveHandler(config, env);
      return handler(request, {});
    }
    return new Response('not found', { status: 404 });
  },
};

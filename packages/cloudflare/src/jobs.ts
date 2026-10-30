import { HypDrivError, type HypDrivEnv, type QueueLike, type ResolvedConfig, getCurrentContext, readEnv } from '@hypdriv/core';
import { signing } from '@hypdriv/security';

export interface EnqueueOptions {
  delaySeconds?: number;
  contentType?: 'json' | 'text' | 'bytes' | 'v8';
}

export interface EnqueueResult {
  transport: 'queue' | 'inline';
  queue: string;
}

/**
 * Sends a message to a configured queue (`cloudflare.bindings.queues[name]`). Without a queue binding the
 * consumer route is invoked inline after the response (signed internal request), so code keeps working
 * on plans or environments without Queues.
 */
export async function enqueue(name: string, body: unknown, options: EnqueueOptions & { env?: HypDrivEnv; config?: ResolvedConfig } = {}): Promise<EnqueueResult> {
  const ctx = getCurrentContext();
  const env = options.env ?? (ctx?.env as HypDrivEnv | undefined);
  const config = options.config ?? ctx?.config;
  if (!env || !config) throw new HypDrivError('E_INTERNAL', 'enqueue() needs the HypDriv request context or explicit env/config');
  const binding = config.cloudflare.bindings.queues[name];
  const queue = binding ? (env[binding] as QueueLike | undefined) : undefined;
  if (queue && typeof queue.send === 'function') {
    await queue.send(body, { ...(options.delaySeconds !== undefined ? { delaySeconds: options.delaySeconds } : {}), ...(options.contentType ? { contentType: options.contentType } : {}) });
    return { transport: 'queue', queue: name };
  }
  const consumer = config.jobs.queues[name];
  if (!consumer) throw new HypDrivError('E_CONFIG', `enqueue(): queue "${name}" has neither a binding nor a consumer route`);
  const origin = ctx?.url.origin ?? config.site.origin ?? 'https://hypdriv.internal';
  const payload = { job: name, messages: [{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), body, attempts: 1 }] };
  let request = new Request(new URL(consumer.path, origin), { method: 'POST', headers: { 'content-type': 'application/json', 'x-hypdriv-internal': '1', 'x-hypdriv-job': name }, body: JSON.stringify(payload) });
  const secret = readEnv(env as Record<string, unknown>, config.security.internalAuth.secretEnv);
  if (secret) request = await signing.signInternalRequest(request, secret);
  const self = env.WORKER_SELF_REFERENCE as { fetch(request: Request): Promise<Response> } | undefined;
  const run = async () => {
    const res = self && typeof self.fetch === 'function' ? await self.fetch(request) : await fetch(request);
    await res.body?.cancel();
  };
  if (ctx) ctx.waitUntil(run());
  else await run();
  return { transport: 'inline', queue: name };
}

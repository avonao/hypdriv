import {
  getCurrentContext,
  getRuntime,
  type HypDrivEnv,
  HypDrivError,
  platformWaitUntil,
  type QueueLike,
  queueEnvKey,
  type ResolvedConfig,
  readEnv,
} from '@hypdriv/core';
import { signing } from '@hypdriv/security';

export interface EnqueueOptions {
  delaySeconds?: number;
  contentType?: 'json' | 'text' | 'bytes' | 'v8';
}

export interface EnqueueResult {
  transport: 'queue' | 'inline';
  queue: string;
}

function usable(candidate: unknown): QueueLike | null {
  const queue = candidate as QueueLike | undefined;
  if (!queue || typeof queue.send !== 'function') return null;
  return queue.ready?.() === false ? null : queue;
}

/** Origin for the inline consumer call outside a request context. */
function inlineOrigin(config: ResolvedConfig, env: Record<string, unknown>): string | null {
  if (config.site.origin) return config.site.origin;
  const vercelUrl = readEnv(env, 'VERCEL_URL');
  if (vercelUrl) return `https://${vercelUrl}`;
  return null;
}

/**
 * Sends a message to a queue: the Cloudflare binding (`cloudflare.bindings.queues[name]`), else a platform
 * producer (`HYPDRIV_QUEUE:<name>`, e.g. Vercel Queues registered through `vercelEnv`). Without a ready
 * producer the consumer route (`jobs.queues[name].path`) is invoked after the response with a signed
 * internal request, so code keeps working on plans or environments without a queue service.
 *
 * Outside a HypDriv request context (Vercel functions, Node hosts) the config and env registered by
 * `createInstrumentation().register()` or `createProxy()` are used; pass `config`/`env` to override.
 */
export async function enqueue(
  name: string,
  body: unknown,
  options: EnqueueOptions & { env?: HypDrivEnv; config?: ResolvedConfig } = {},
): Promise<EnqueueResult> {
  const ctx = getCurrentContext();
  const runtime = getRuntime();
  const env = options.env ?? (ctx?.env as HypDrivEnv | undefined) ?? runtime?.env;
  const config = options.config ?? ctx?.config ?? runtime?.config;
  if (!env || !config)
    throw new HypDrivError(
      'E_INTERNAL',
      'enqueue() needs the HypDriv request context, a registered runtime (createInstrumentation in instrumentation.ts) or explicit env/config',
    );
  const record = env as Record<string, unknown>;
  const binding = config.cloudflare.bindings.queues[name];
  const queue = usable(binding ? record[binding] : undefined) ?? usable(record[queueEnvKey(name)]);
  if (queue) {
    await queue.send(body, {
      ...(options.delaySeconds !== undefined ? { delaySeconds: options.delaySeconds } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
    return { transport: 'queue', queue: name };
  }
  const consumer = config.jobs.queues[name];
  if (!consumer)
    throw new HypDrivError(
      'E_CONFIG',
      `enqueue(): queue "${name}" has neither a producer (binding or platform queue) nor a consumer route`,
    );
  const self = record.WORKER_SELF_REFERENCE as { fetch(request: Request): Promise<Response> } | undefined;
  const hasSelf = Boolean(self && typeof self.fetch === 'function');
  const origin =
    ctx?.url.origin ?? inlineOrigin(config, record) ?? (hasSelf ? 'https://hypdriv.internal' : null);
  if (!origin)
    throw new HypDrivError(
      'E_CONFIG',
      `enqueue(): cannot reach the consumer route of "${name}" outside a request; set site.origin in hypdriv.config`,
    );
  const payload = {
    job: name,
    messages: [{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), body, attempts: 1 }],
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-hypdriv-internal': '1',
    'x-hypdriv-job': name,
  };
  // Vercel Deployment Protection: the automation bypass lets the function call its own deployment.
  const bypass = readEnv(record, 'VERCEL_AUTOMATION_BYPASS_SECRET');
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  let request = new Request(new URL(consumer.path, origin), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const secret = readEnv(record, config.security.internalAuth.secretEnv);
  if (secret) request = await signing.signInternalRequest(request, secret);
  const run = async () => {
    const res = hasSelf ? await self!.fetch(request) : await fetch(request);
    await res.body?.cancel();
    if (!res.ok)
      throw new HypDrivError('E_UPSTREAM', `enqueue(): consumer route answered ${res.status}`, {
        queue: name,
      });
  };
  const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : platformWaitUntil();
  if (waitUntil)
    waitUntil(
      run().catch((err: Error) =>
        (ctx?.log ?? console).error?.('enqueue: inline consumer call failed', {
          queue: name,
          error: err.message,
        }),
      ),
    );
  else await run();
  return { transport: 'inline', queue: name };
}

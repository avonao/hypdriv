import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import {
  createWorker,
  type EmailMessageLike,
  type ExecutionContextLike,
  type MessageBatchLike,
  type ScheduledEventLike,
  type TailEventLike,
} from '@hypdriv/cloudflare';
import { type HypDrivEnv, loadConfig, queueConsumerFor } from '@hypdriv/core';
import wsAdapter from 'crossws/adapters/cloudflare';
import { createHandler } from 'nitropack/presets/cloudflare/runtime/_module-handler';
import { useNitroApp } from 'nitropack/runtime';
import { isPublicAssetURL } from '#nitro-internal-virtual/public-assets';
import { normalizeRequestPath, prerenderedPaths } from './prerendered';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

const resolved = loadConfig(config);
const nitroApp = useNitroApp();
const ws = import.meta._websocket
  ? wsAdapter((nitroApp.h3App as unknown as { websocket: unknown }).websocket)
  : undefined;
// Nitro's own Cloudflare module handler, without its static-assets shortcut (the app below serves assets).
const nitro = createHandler({});
const prerendered = prerenderedPaths(manifest);

/**
 * The application as the Hypdriv Worker shell sees it: Workers Static Assets for build assets and prerendered
 * pages that reach the Worker (`assets.run_worker_first`), Nitro for everything else.
 */
async function app(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> {
  const assets = env.ASSETS as AssetsBinding | undefined;
  if (assets && (request.method === 'GET' || request.method === 'HEAD')) {
    const { pathname } = new URL(request.url);
    if (isPublicAssetURL(pathname)) return assets.fetch(request);
    if (prerendered.has(normalizeRequestPath(pathname))) {
      const response = await assets.fetch(request);
      if (response.status !== 404) return response;
      void response.body?.cancel().catch(() => undefined);
    }
  }
  return nitro.fetch(request, env, ctx);
}

const worker = createWorker({
  config: resolved,
  manifest,
  app: async () => ({ fetch: app }),
});

/**
 * Hypdriv's Worker for Nuxt's `cloudflare-module` preset (the module's generated entry imports Nitro's polyfills
 * first, then re-exports this and the Durable Objects): the Hypdriv shell (`createWorker`) around Nitro,
 * so the full pipeline — `HTMLRewriter` CSP nonce injection and the edge stages included — runs on a true Web
 * `Request`/`Response`. Cron triggers run Hypdriv's jobs and Nitro's `cloudflare:scheduled` hooks and tasks; queue
 * batches and email go to Hypdriv when `jobs.queues` / `jobs.email` configure them, otherwise to Nitro's
 * `cloudflare:queue` / `cloudflare:email` hooks. WebSocket upgrades (`experimental.websocket`) go straight to Nitro.
 */
export default {
  fetch(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> {
    if (ws && request.headers.get('upgrade')?.toLowerCase() === 'websocket')
      return ws.handleUpgrade(request, env, ctx);
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledEventLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    nitro.scheduled(controller, env, ctx);
    await worker.scheduled(controller, env, ctx);
  },
  async queue(batch: MessageBatchLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    if (queueConsumerFor(resolved, batch.queue)) return worker.queue(batch, env, ctx);
    nitro.queue(batch, env, ctx);
  },
  async email(message: EmailMessageLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    if (resolved.jobs.email) return worker.email(message, env, ctx);
    nitro.email(message, env, ctx);
  },
  async tail(events: TailEventLike[], env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    nitro.tail(events, env, ctx);
    await worker.tail(events, env, ctx);
  },
  trace(traces: unknown, env: HypDrivEnv, ctx: ExecutionContextLike): void {
    nitro.trace(traces, env, ctx);
  },
};

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
import { useNitroApp, useNitroHooks } from 'nitro/app';
import { normalizeRequestPath, prerenderedPaths } from '../prerendered';
import type { Nitro3Request } from './hook';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface NitroApp3 {
  fetch(request: Request): Response | Promise<Response>;
  /** Set while Nitro's async runtime plugins initialise. */
  ready?: Promise<void> | undefined;
}

const resolved = loadConfig(config);
const nitroApp = useNitroApp() as unknown as NitroApp3;
const nitroHooks = useNitroHooks() as unknown as {
  callHook(name: string, payload: unknown): Promise<void> | void;
};
const prerendered = prerenderedPaths(manifest);
const FILE_LIKE = /\.[A-Za-z0-9]{1,12}$/;

/** Runs `fn` once Nitro's runtime plugins have initialised (Nitro holds platform events until then, too). */
function afterNitroReady(fn: () => Promise<void> | void): Promise<void> | void {
  return nitroApp.ready ? nitroApp.ready.then(fn) : fn();
}

/** Dispatches a Worker event to Nitro's `cloudflare:*` runtime hooks (`scheduled`, `queue`, `email`, `tail`, `trace`). */
function toNitroHook(name: string, payload: Record<string, unknown>, ctx: ExecutionContextLike): void {
  ctx.waitUntil(Promise.resolve(afterNitroReady(() => nitroHooks.callHook(name, payload))));
}

/** Stamps what Nitro 3's Cloudflare entry stamps on the request: bindings, the execution context, the client IP. */
function augment(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Nitro3Request {
  const req = request as Nitro3Request;
  req.ip = request.headers.get('cf-connecting-ip') || undefined;
  req.runtime ??= { name: 'cloudflare' };
  req.runtime.cloudflare = { ...req.runtime.cloudflare, env, context: ctx };
  req.waitUntil = ctx.waitUntil.bind(ctx);
  return req;
}

/**
 * The application as the Hypdriv Worker shell sees it: Workers Static Assets for build assets and prerendered
 * pages that reach the Worker (`assets.run_worker_first`), Nitro for everything else.
 */
async function app(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> {
  const assets = env.ASSETS as AssetsBinding | undefined;
  if (assets && (request.method === 'GET' || request.method === 'HEAD')) {
    const { pathname } = new URL(request.url);
    // Files of the public directory (the platform answers them before the Worker unless `run_worker_first`
    // routes them here) and the documents the build prerendered; a miss falls through to Nitro.
    if (FILE_LIKE.test(pathname) || prerendered.has(normalizeRequestPath(pathname))) {
      const response = await assets.fetch(request);
      if (response.status !== 404) return response;
      void response.body?.cancel().catch(() => undefined);
    }
  }
  return nitroApp.fetch(augment(request, env, ctx));
}

const worker = createWorker({
  config: resolved,
  manifest,
  app: async () => ({ fetch: app }),
});

/**
 * Hypdriv's Worker for Nitro 3's `cloudflare-module` preset (the module sets it as the build's `entry`; Nitro adds the
 * `server.ts` exports): the Hypdriv shell (`createWorker`) around `nitroApp.fetch`, so the full pipeline —
 * `HTMLRewriter` CSP nonce injection and the edge stages included — runs on a true Web `Request`/`Response`. Cron
 * triggers run Hypdriv's jobs and Nitro's `cloudflare:scheduled` hooks and tasks; queue batches and email go to
 * Hypdriv when `jobs.queues` / `jobs.email` configure a consumer, otherwise to Nitro's `cloudflare:queue` /
 * `cloudflare:email` hooks.
 */
export default {
  fetch(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledEventLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    toNitroHook('cloudflare:scheduled', { controller, env, context: ctx }, ctx);
    await worker.scheduled(controller, env, ctx);
  },
  async queue(batch: MessageBatchLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    if (queueConsumerFor(resolved, batch.queue)) return worker.queue(batch, env, ctx);
    toNitroHook('cloudflare:queue', { batch, env, context: ctx }, ctx);
  },
  async email(message: EmailMessageLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    if (resolved.jobs.email) return worker.email(message, env, ctx);
    toNitroHook('cloudflare:email', { message, env, context: ctx }, ctx);
  },
  async tail(events: TailEventLike[], env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void> {
    toNitroHook('cloudflare:tail', { traces: events, env, context: ctx }, ctx);
    await worker.tail(events, env, ctx);
  },
  trace(traces: unknown, env: HypDrivEnv, ctx: ExecutionContextLike): void {
    toNitroHook('cloudflare:trace', { traces, env, context: ctx }, ctx);
  },
};

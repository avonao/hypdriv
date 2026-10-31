import {
  type CreateWorkerOptions,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import type { HypDrivConfig, HypDrivEnv, HypManifest, ResolvedConfig } from '@hypdriv/core';
import { isBuildPrerender } from './runtime';

/**
 * `@hypdriv/vinext/worker` — a Cloudflare Worker entry for vinext that owns the Worker: Hypdriv's Worker shell
 * (`createWorker`) runs the full Drivetrain around vinext's fetch handler (HTML rewriting, edge cache, Durable
 * Object rate limits and tag index) and adds `scheduled`, `queue`, `email` and `tail` handlers. The request hook
 * the Hypdriv plugin installs inside vinext passes through, since the shell already ran the stages.
 *
 * ```ts
 * // worker/index.ts (wrangler `main`)
 * /// <reference types="@hypdriv/vinext/virtual" />
 * import config from 'virtual:hypdriv/config';
 * import manifest from 'virtual:hypdriv/manifest';
 * import handler from 'vinext/server/fetch-handler';
 * import { createVinextWorker } from '@hypdriv/vinext/worker';
 * export * from 'vinext/server/fetch-handler';
 * export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
 * export default createVinextWorker({ config, manifest, app: handler });
 * ```
 */

/** vinext's Worker handler (`vinext/server/fetch-handler`'s default export). */
export interface VinextWorkerHandler {
  fetch(request: Request, env: never, ctx: never): Promise<Response> | Response;
}

export interface CreateVinextWorkerOptions extends Omit<CreateWorkerOptions, 'next' | 'app' | 'config'> {
  config: HypDrivConfig | ResolvedConfig;
  /** vinext's Worker handler, or a loader of it (`() => import('vinext/server/fetch-handler')`). */
  app:
    | VinextWorkerHandler
    | (() => Promise<VinextWorkerHandler | { default: VinextWorkerHandler }> | VinextWorkerHandler);
  /** The manifest (`virtual:hypdriv/manifest`) or a loader of it. */
  manifest?: HypManifest | (() => Promise<{ default: HypManifest } | HypManifest>);
}

type FetchHandler = (
  request: Request,
  env: unknown,
  ctx: ExecutionContextLike,
) => Promise<Response> | Response;

function fetchOf(mod: VinextWorkerHandler | { default: VinextWorkerHandler }): FetchHandler {
  const handler = 'default' in mod && mod.default ? mod.default : (mod as VinextWorkerHandler);
  if (!handler || typeof handler.fetch !== 'function')
    throw new TypeError(
      'createVinextWorker: `app` must be vinext/server/fetch-handler (an object with fetch)',
    );
  return (request, env, ctx) => handler.fetch.call(handler, request, env as never, ctx as never);
}

/**
 * Creates the Cloudflare Worker for a vinext app. During vinext's build-time prerender (which runs this Worker
 * in Node) requests go straight to vinext.
 */
export function createVinextWorker(options: CreateVinextWorkerOptions): HypDrivWorker {
  const { app, ...rest } = options;
  let loaded: Promise<FetchHandler> | null = null;
  const load = (): Promise<FetchHandler> => {
    loaded ??= Promise.resolve(typeof app === 'function' ? app() : app).then(fetchOf);
    loaded.catch(() => {
      loaded = null;
    });
    return loaded;
  };
  const worker = createWorker({
    ...rest,
    app: async () => {
      const fetch = await load();
      return { default: { fetch } };
    },
  });
  return {
    ...worker,
    async fetch(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> {
      if (isBuildPrerender()) return (await load())(request, env, ctx);
      return worker.fetch(request, env, ctx);
    },
  };
}

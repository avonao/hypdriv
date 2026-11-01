/**
 * `@hypdriv/solid-start/cloudflare` — SolidStart inside Hypdriv's Cloudflare Worker shell. The shell
 * (`createWorker` from `@hypdriv/cloudflare`) runs the full Drivetrain with `HTMLRewriter` around SolidStart's
 * server entry, answers `/_hypdriv/*`, and handles `scheduled`, `queue` and `email` events (dispatched to your job
 * endpoints as signed requests). Use it with `@cloudflare/vite-plugin` (`viteEnvironment: { name: 'ssr' }`):
 *
 * ```ts
 * // src/worker.ts — wrangler `main` (the Worker entry must be your own file, not SolidStart's `entry-server`)
 * /// <reference types="@hypdriv/solid-start/virtual" />
 * import config from 'virtual:hypdriv/config';
 * import { createSolidStartWorker } from '@hypdriv/solid-start/cloudflare';
 * export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
 * export default createSolidStartWorker({
 *   config,
 *   manifest: () => import('virtual:hypdriv/manifest'),
 *   entry: () => import('./entry-server'),
 * });
 * ```
 */
import {
  type AppWorkerModule,
  type CreateWorkerOptions,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';

/** SolidStart's server entry: the default export of `src/entry-server.tsx` (`createHandler(…)`, an H3 app). */
export interface SolidStartServerEntry {
  fetch(request: Request, ...rest: never[]): Promise<Response> | Response;
}

export interface SolidStartWorkerOptions extends Omit<CreateWorkerOptions, 'next' | 'app'> {
  /**
   * Loads SolidStart's server entry: `() => import('./entry-server')`, the module whose default export is
   * `createHandler(…)`. (The `@solidjs/start/server/entry` alias would make Vite load the module twice.)
   */
  entry: () => Promise<SolidStartServerEntry | { default: SolidStartServerEntry }>;
  /**
   * The static-assets binding answered first for GET/HEAD requests, so public files keep being served as built when
   * the Worker runs first (`assets.run_worker_first`, which gives them the request stages). `false` sends
   * everything to SolidStart. Default `ASSETS`.
   */
  assets?: string | false;
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Hands Workers' `env` and `ctx` to the application the way srvx does for every other runtime
 * (`request.runtime.cloudflare`), so SolidStart code reaches the bindings through
 * `getRequestEvent()?.nativeEvent.req.runtime?.cloudflare?.env`. The request is extended in place; a request that
 * refuses it is copied.
 */
export function withCloudflareRuntime(request: Request, env: unknown, ctx: ExecutionContextLike): Request {
  const runtime = { name: 'cloudflare', cloudflare: { env, context: ctx } };
  const define = (target: Request) =>
    Object.defineProperty(target, 'runtime', { value: runtime, configurable: true, enumerable: false });
  try {
    return define(request);
  } catch {
    return define(new Request(request));
  }
}

/**
 * The application worker `createWorker({ app })` expects, wrapping SolidStart's server entry: GET/HEAD requests are
 * answered from the assets binding first, everything else renders in SolidStart with Workers' `env` and `ctx` on
 * `request.runtime.cloudflare`.
 */
export function startApp(
  entry: SolidStartWorkerOptions['entry'],
  assets: string | false = 'ASSETS',
): () => Promise<AppWorkerModule['default']> {
  return async () => {
    const loaded = await entry();
    const start = 'default' in loaded ? loaded.default : loaded;
    return {
      async fetch(request: Request, env: unknown, ctx: ExecutionContextLike) {
        const binding =
          assets === false
            ? undefined
            : ((env as Record<string, unknown> | undefined)?.[assets] as AssetsBinding | undefined);
        if (
          binding &&
          typeof binding.fetch === 'function' &&
          (request.method === 'GET' || request.method === 'HEAD')
        ) {
          const asset = await binding.fetch(request);
          if (asset.status !== 404) return asset;
          void asset.body?.cancel().catch(() => undefined);
        }
        return start.fetch(withCloudflareRuntime(request, env, ctx));
      },
    };
  };
}

/**
 * Creates the Worker entry for a SolidStart app: `createWorker()` with SolidStart as the application. Pages are
 * rendered per request by SolidStart behind the shell, so the shell reads the build manifest as is; `hypdriv()`
 * writes the final manifest into the Worker bundle after the build.
 */
export function createSolidStartWorker(options: SolidStartWorkerOptions): HypDrivWorker {
  const { entry, assets = 'ASSETS', ...rest } = options;
  const load = startApp(entry, assets);
  let app: Promise<AppWorkerModule['default']> | null = null;
  return createWorker({
    ...rest,
    app: () => {
      app ??= load();
      return app;
    },
  });
}

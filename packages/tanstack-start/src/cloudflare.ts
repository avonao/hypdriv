/**
 * `@hypdriv/tanstack-start/cloudflare` — TanStack Start inside HypDriv's Cloudflare Worker shell. The shell
 * (`createWorker` from `@hypdriv/cloudflare`) runs the full Drivetrain with `HTMLRewriter` around Start, answers
 * `/_hypdriv/*`, and handles `scheduled`, `queue` and `email` events (dispatched to your job endpoints as signed
 * requests). The request middleware in `src/start.ts` passes through inside it and still hands the nonce to the
 * router.
 *
 * ```ts
 * // src/worker.ts — wrangler `main` (the Worker entry must be your own file, not Start's package entry)
 * import config from 'virtual:hypdriv/config';
 * import { createStartWorker } from '@hypdriv/tanstack-start/cloudflare';
 * export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
 * export default createStartWorker({ config, manifest: () => import('virtual:hypdriv/manifest') });
 * ```
 */
import { prerenderToken } from 'virtual:hypdriv/tanstack-start';
import {
  type AppWorkerModule,
  type CreateWorkerOptions,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import type { HypDrivEnv } from '@hypdriv/core';
import { renderedManifestLoader } from './manifest';
import { isPrerenderRequest } from './middleware';

export { renderedManifest, renderedManifestLoader } from './manifest';

/** TanStack Start's server entry (`@tanstack/react-start/server-entry`, or your `createServerEntry()` result). */
export interface StartServerEntry {
  fetch(request: Request, opts?: { context?: Record<string, unknown> }): Promise<Response> | Response;
}

export interface StartWorkerOptions extends Omit<CreateWorkerOptions, 'next' | 'app'> {
  /**
   * Loads Start's server entry. Default: `import('@tanstack/react-start/server-entry')` — Start's handler with
   * its request scope and error handling.
   */
  entry?: () => Promise<StartServerEntry | { default: StartServerEntry }>;
  /**
   * The build's prerender token (default: `virtual:hypdriv/tanstack-start`): Start's prerender requests go to
   * Start directly, outside the shell, so static documents carry no per-request state.
   */
  prerenderToken?: string;
  /**
   * The static-assets binding answered first for GET/HEAD requests, so prerendered pages and public files keep being
   * served as built when the Worker runs first (`assets.run_worker_first`, which gives them the request stages).
   * `false` sends everything to Start. Default `ASSETS`.
   */
  assets?: string | false;
}

/**
 * The application worker `createWorker({ app })` expects, wrapping Start's server entry: Workers' `env` and
 * `ctx` reach Start (and HypDriv's middleware) as `context.cloudflare`, never as Start's request options.
 */
export function startApp(
  entry: () => Promise<StartServerEntry | { default: StartServerEntry }> = () =>
    import('@tanstack/react-start/server-entry') as Promise<{ default: StartServerEntry }>,
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
        return start.fetch(request, { context: { cloudflare: { env, ctx } } });
      },
    };
  };
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Creates the Worker entry for a TanStack Start app: `createWorker()` with Start as the application. GET/HEAD
 * requests are answered from the assets binding first, so with `assets.run_worker_first` prerendered pages get the
 * request stages and are still served as built (hash CSP from the build manifest); everything else is rendered by
 * Start per request. With `assets: false` every page that reaches the Worker is rendered, and the shell reads the
 * manifest through `renderedManifest()`.
 */
export function createStartWorker(options: StartWorkerOptions): HypDrivWorker {
  const { entry, manifest, prerenderToken: token = prerenderToken, assets = 'ASSETS', ...rest } = options;
  // With the assets binding answered first, prerendered pages reach the client as built: the build manifest (hash
  // CSP for them) is the right one. Without it, every page that reaches the Worker is rendered per request.
  const rendered = assets === false ? renderedManifestLoader(manifest) : manifest;
  const load = startApp(entry, assets);
  let app: Promise<AppWorkerModule['default']> | null = null;
  const worker = createWorker({
    ...rest,
    ...(rendered ? { manifest: rendered } : {}),
    app: () => {
      app ??= load();
      return app;
    },
  });
  return {
    ...worker,
    async fetch(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> {
      // The build's own prerender requests (`vite build` runs the Worker in workerd to prerender): the static
      // document must be what Start renders, without a request's nonce, id or flags.
      if (isPrerenderRequest(request, token)) {
        app ??= load();
        return (await app).fetch(request, env, ctx);
      }
      return worker.fetch(request, env, ctx);
    },
  };
}

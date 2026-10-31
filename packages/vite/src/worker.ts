import { type CreateWorkerOptions, createWorker, type HypDrivWorker } from '@hypdriv/cloudflare';
import type { HypDrivConfig, HypManifest, ResolvedConfig } from '@hypdriv/core';

/**
 * `@hypdriv/vite/worker` — the Cloudflare Worker for a plain Vite app (single- or multi-page): the static assets
 * (`env.ASSETS`, with the `not_found_handling` your wrangler config chooses) served through the full HypDriv
 * shell — security headers, CSP, rate limiting, bot shield, geo, flags, redirects, maintenance, `/_hypdriv/*`,
 * plus `scheduled`, `queue` and `email` handlers. Use it with `@cloudflare/vite-plugin` and
 * `assets.run_worker_first` for navigations:
 *
 * ```ts
 * // src/worker.ts (wrangler `main`)
 * /// <reference types="@hypdriv/vite/virtual" />
 * import config from 'virtual:hypdriv/config';
 * import { assetsWorker } from '@hypdriv/vite/worker';
 * export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
 * export default assetsWorker({ config, manifest: () => import('virtual:hypdriv/manifest') });
 * ```
 */
export interface AssetsWorkerOptions
  extends Omit<CreateWorkerOptions, 'next' | 'app' | 'config' | 'manifest'> {
  config: HypDrivConfig | ResolvedConfig;
  /** The manifest module (`() => import('virtual:hypdriv/manifest')`) or object. */
  manifest?: HypManifest | (() => Promise<{ default: HypManifest } | HypManifest>);
  /** The static-assets binding name (default `ASSETS`). */
  assetsBinding?: string;
  /**
   * Answers requests before the assets (API routes of your own); return `null` to fall through to the assets.
   */
  handle?: (
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) => Promise<Response | null> | Response | null;
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export function assetsWorker(options: AssetsWorkerOptions): HypDrivWorker {
  const { config, manifest, assetsBinding = 'ASSETS', handle, ...rest } = options;
  return createWorker({
    ...rest,
    config,
    ...(manifest ? { manifest } : {}),
    app: async () => ({
      async fetch(request: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) {
        const bindings = (env ?? {}) as Record<string, unknown>;
        if (handle) {
          const own = await handle(request, bindings, ctx);
          if (own) return own;
        }
        const assets = bindings[assetsBinding] as AssetsBinding | undefined;
        if (!assets || typeof assets.fetch !== 'function')
          return new Response(`hypdriv: the "${assetsBinding}" static-assets binding is missing`, {
            status: 500,
          });
        return assets.fetch(request);
      },
    }),
  });
}

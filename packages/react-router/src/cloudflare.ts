import {
  type CreateWorkerOptions,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import type { HypDrivEnv, HypManifest } from '@hypdriv/core';
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';
import { dataRedirect, withDataRequests } from './data-requests';
import { cloudflareContext } from './server';
import { isPrerenderRequest } from './shared';

/**
 * `@hypdriv/react-router/cloudflare` — the Worker entry of a React Router app on Cloudflare: HypDriv's Worker shell
 * (`createWorker`) around React Router, so the pipeline runs for every request the Worker receives — routes, 404s,
 * `/__manifest` and, with `assets.run_worker_first`, prerendered pages and other static files — plus `scheduled`,
 * `queue` and `email` handlers for HypDriv's jobs. The root `middleware` passes through inside it.
 *
 * ```ts
 * // workers/app.ts (wrangler `main`)
 * /// <reference types="@hypdriv/vite/virtual" />
 * import config from 'virtual:hypdriv/config';
 * import { reactRouterWorker } from '@hypdriv/react-router/cloudflare';
 * export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
 * export default reactRouterWorker({ config });
 * ```
 */
export { type CloudflareRequestContext, cloudflareContext } from './server';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ReactRouterWorkerOptions extends Omit<CreateWorkerOptions, 'next' | 'app' | 'manifest'> {
  /** The build manifest (default: `virtual:hypdriv/manifest`). */
  manifest?: HypManifest | (() => Promise<{ default: HypManifest } | HypManifest>);
  /** The React Router server build (default: `virtual:react-router/server-build`, loaded on first use). */
  build?: ServerBuild | (() => Promise<ServerBuild> | ServerBuild);
  /** React Router's server mode (default: `NODE_ENV`, else `production`). */
  mode?: string;
  /**
   * The static-assets binding answered first for GET/HEAD requests, so prerendered pages and public files keep
   * being served statically when the Worker runs first (`assets.run_worker_first`). `false` sends everything to
   * React Router. Default `ASSETS`.
   */
  assets?: string | false;
  /** Fills the router context of each request (bindings, services) next to `cloudflareContext`. */
  getLoadContext?: (args: {
    request: Request;
    env: HypDrivEnv;
    ctx: ExecutionContextLike;
    context: RouterContextProvider;
  }) => void | Promise<void>;
  /** The build's prerender token (default: `virtual:hypdriv/react-router`). */
  prerenderToken?: string;
}

function serverMode(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV === 'development' ? 'development' : 'production';
}

function hasExtension(pathname: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(pathname.split('/').pop() ?? '');
}

function isNavigation(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

async function virtualToken(): Promise<string> {
  try {
    const mod = (await import('virtual:hypdriv/react-router')) as { prerenderToken?: string };
    return typeof mod.prerenderToken === 'string' ? mod.prerenderToken : '';
  } catch {
    return '';
  }
}

/**
 * Creates the Cloudflare Worker of a React Router app with HypDriv. Static files come from the assets binding
 * first (GET/HEAD); single-page apps (`ssr: false`) get their shell (`__spa-fallback.html`, else `index.html`) for
 * unknown navigations; everything else goes to React Router with `cloudflareContext` in the router context. The
 * build's own prerender requests skip the shell.
 */
export function reactRouterWorker(options: ReactRouterWorkerOptions): HypDrivWorker {
  const { build, mode, assets = 'ASSETS', getLoadContext, prerenderToken, manifest, ...rest } = options;
  let buildPromise: Promise<ServerBuild> | null = null;
  const loadBuild = (): Promise<ServerBuild> => {
    buildPromise ??= Promise.resolve(
      build === undefined
        ? (import('virtual:react-router/server-build') as unknown as Promise<ServerBuild>)
        : typeof build === 'function'
          ? build()
          : build,
    ).catch((err: unknown) => {
      buildPromise = null;
      throw err;
    });
    return buildPromise;
  };
  const requestHandler = createRequestHandler(loadBuild, mode ?? serverMode());
  let tokenPromise: Promise<string> | null = null;
  const token = () => {
    tokenPromise ??= prerenderToken !== undefined ? Promise.resolve(prerenderToken) : virtualToken();
    return tokenPromise;
  };

  const app = async (request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response> => {
    const prerender = isPrerenderRequest(request, await token());
    const binding = assets === false ? undefined : (env[assets] as AssetsBinding | undefined);
    if (!prerender && binding && typeof binding.fetch === 'function') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const asset = await binding.fetch(request);
        if (asset.status !== 404) return asset;
        void asset.body?.cancel().catch(() => undefined);
        const server = await loadBuild();
        const url = new URL(request.url);
        if (server.ssr === false && isNavigation(request) && !hasExtension(url.pathname)) {
          const base = (server.basename ?? '/').replace(/\/?$/, '/');
          for (const shell of [`${base}__spa-fallback`, base]) {
            const response = await binding.fetch(new Request(new URL(shell, url), request));
            if (response.ok) return response;
            void response.body?.cancel().catch(() => undefined);
          }
        }
      }
    }
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as Record<string, unknown>,
      ctx,
      cf: (request as { cf?: Record<string, unknown> }).cf,
    });
    await getLoadContext?.({ request, env, ctx, context });
    return requestHandler(request, context);
  };

  const shell = createWorker({
    ...rest,
    config: withDataRequests(rest.config),
    manifest:
      manifest ??
      (() => import('virtual:hypdriv/manifest') as Promise<{ default: HypManifest } | HypManifest>),
    app: async () => ({
      fetch: (request: Request, env: unknown, ctx: ExecutionContextLike) =>
        app(request, env as HypDrivEnv, ctx),
    }),
  });

  return {
    ...shell,
    async fetch(request, env, ctx) {
      // The build's prerender requests (React Router renders through the Worker in `vite preview`) skip the shell.
      if (isPrerenderRequest(request, await token())) return app(request, env, ctx);
      // React Router answers data requests' redirects itself (single fetch); the pipeline's own need converting.
      return dataRedirect(request, await shell.fetch(request, env, ctx));
    },
  };
}

/**
 * `@hypdriv/tanstack-start` — Hypdriv for TanStack Start on the server: the global request middleware that runs
 * the Drivetrain around everything Start answers, and the router's `ssr.nonce` option. Browsers resolve this entry
 * to inert stand-ins (`src/start.ts` and `src/router.tsx` are part of the client bundle too).
 *
 * ```ts
 * // src/start.ts
 * import { hypdrivRequestMiddleware } from '@hypdriv/tanstack-start';
 * const requestMiddleware = hypdrivRequestMiddleware();
 * export const startInstance = createStart(() => ({ requestMiddleware }));
 * ```
 */
import config from 'virtual:hypdriv/config';
import { prerenderToken } from 'virtual:hypdriv/tanstack-start';
import type { HypDrivConfig, ResolvedConfig } from '@hypdriv/core';
import type { ManifestSource } from '@hypdriv/runtime';
import { type CsrfMiddlewareOptions, createCsrfMiddleware } from '@tanstack/react-start';
import {
  type CreateHypDrivMiddlewareOptions,
  createHypDrivMiddleware,
  type HypDrivMiddlewareWithHandler,
  type HypDrivRequestMiddleware,
} from './middleware';

export { PRERENDER_HEADER } from './constants';
export { renderedManifest, renderedManifestSource } from './manifest';
export {
  type CloudflareStartContext,
  type CreateHypDrivMiddlewareOptions,
  createHypDrivMiddleware,
  type HypDrivMiddlewareWithHandler,
  type HypDrivRequestMiddleware,
  type HypDrivStartContext,
  isPrerenderRequest,
  nativeRequest,
  platformInput,
} from './middleware';
export { type HypDrivSsrOptions, hypdrivSsr } from './ssr';

/** Options of `hypdrivMiddleware()`: `createHandler` options; config and manifest default to the build's. */
export interface HypDrivMiddlewareOptions
  extends Omit<CreateHypDrivMiddlewareOptions, 'config' | 'manifest' | 'prerenderToken'> {
  /** Default: `virtual:hypdriv/config` (the application's `hypdriv.config.ts`). */
  config?: HypDrivConfig | ResolvedConfig;
  /** Default: `virtual:hypdriv/manifest` (the build manifest, patched in after prerendering). */
  manifest?: ManifestSource;
}

const loadManifest = () => import('virtual:hypdriv/manifest');

let shared: HypDrivMiddlewareWithHandler | null = null;

/**
 * The Hypdriv request middleware for `src/start.ts`. Without options it returns one shared instance (Start calls
 * the `createStart()` callback per request, and the pipeline's platform — rate-limit counters, caches — must
 * live as long as the server). With options it creates a new instance: create it once, at module scope.
 */
export function hypdrivMiddleware(options?: HypDrivMiddlewareOptions): HypDrivMiddlewareWithHandler {
  if (!options) {
    shared ??= createHypDrivMiddleware({ config, manifest: loadManifest, prerenderToken });
    return shared;
  }
  return createHypDrivMiddleware({
    ...options,
    config: options.config ?? config,
    manifest: options.manifest === undefined ? loadManifest : options.manifest,
    prerenderToken,
  });
}

/** The CSRF middleware `hypdrivRequestMiddleware()` adds: Start's own, for server functions. */
export type ServerFnCsrfMiddleware = ReturnType<typeof createCsrfMiddleware>;

export interface HypDrivRequestMiddlewareOptions extends HypDrivMiddlewareOptions {
  /**
   * Start's CSRF protection for server functions (`createCsrfMiddleware`). A custom `src/start.ts` replaces
   * Start's default middleware, which would otherwise install it; Hypdriv adds it back after itself. Pass
   * options to adjust it (the filter defaults to server-function requests), or `false` when you install your own.
   */
  csrf?: false | CsrfMiddlewareOptions;
}

let sharedList: readonly [HypDrivRequestMiddleware, ServerFnCsrfMiddleware] | null = null;

/**
 * The request middleware list for `src/start.ts`: Hypdriv first, so it wraps every response below it — CSRF
 * rejections included — then Start's CSRF protection for server functions. Call it once at module scope (without
 * options it returns a shared list).
 */
export function hypdrivRequestMiddleware(): readonly [HypDrivRequestMiddleware, ServerFnCsrfMiddleware];
export function hypdrivRequestMiddleware(
  options: HypDrivRequestMiddlewareOptions & { csrf: false },
): readonly [HypDrivRequestMiddleware];
export function hypdrivRequestMiddleware(
  options: HypDrivRequestMiddlewareOptions,
): readonly [HypDrivRequestMiddleware, ServerFnCsrfMiddleware];
export function hypdrivRequestMiddleware(
  options?: HypDrivRequestMiddlewareOptions,
): readonly [HypDrivRequestMiddleware] | readonly [HypDrivRequestMiddleware, ServerFnCsrfMiddleware] {
  if (!options) {
    sharedList ??= [hypdrivMiddleware(), serverFnCsrf(undefined)] as const;
    return sharedList;
  }
  const { csrf, ...rest } = options;
  const hypdriv = Object.keys(rest).length ? hypdrivMiddleware(rest) : hypdrivMiddleware();
  if (csrf === false) return [hypdriv] as const;
  return [hypdriv, serverFnCsrf(csrf)] as const;
}

function serverFnCsrf(options: CsrfMiddlewareOptions | undefined): ServerFnCsrfMiddleware {
  return createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn', ...options });
}

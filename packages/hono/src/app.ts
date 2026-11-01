import type { HypHandler } from '@hypdriv/runtime';
import { createHandler } from '@hypdriv/runtime';
import { type HonoRoutesSource, honoManifest } from './manifest';
import { HOST_LABEL, type HypDrivHonoOptions, platformInput } from './middleware';

/** What `wrapHono()` needs from the app: Hono's `fetch` and its routes. */
export interface HonoAppLike extends HonoRoutesSource {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** A Workers-style `fetch(request, env, ctx)` plus the handler behind it. */
export interface WrappedHonoApp {
  fetch(request: Request, env?: unknown, ctx?: WaitUntilContext): Promise<Response>;
  readonly handler: HypHandler;
}

/**
 * Wraps a whole Hono app in the Hypdriv Drivetrain. The result has the app's `fetch` signature, so it is what a
 * Worker exports (`export default wrapHono(app, { config })`), what `serve({ fetch })` of `@hono/node-server`
 * takes, and what Bun (`Bun.serve`), Deno (`Deno.serve`) and Vercel Functions (`export const GET = (request) =>
 * wrapped.fetch(request)`) call. The pipeline's forwarded request (sanitised headers, the stages' `x-hypdriv-*`
 * headers) is what the app receives; the CSP nonce is `nonce()` from this package.
 *
 * The manifest is derived from the app's routes unless `options.manifest` says otherwise.
 */
export function wrapHono(app: HonoAppLike, options: HypDrivHonoOptions): WrappedHonoApp {
  const { config, manifest, host, app: _ignored, ...rest } = options;
  const handler = createHandler({
    ...rest,
    config,
    manifest: manifest !== undefined ? manifest : () => honoManifest(app),
    host: host ?? HOST_LABEL,
  });
  return {
    handler,
    fetch: (request, env, ctx) =>
      handler(request, {
        ...platformInput(request, env, ctx, handler.config),
        upstream: (forwarded) => app.fetch(forwarded, env, ctx),
      }),
  };
}

export type { HypHandler };

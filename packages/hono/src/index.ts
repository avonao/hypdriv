/**
 * `@hypdriv/hono` — Hypdriv for Hono on Cloudflare Workers, Vercel, Node, Bun and Deno.
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { useHypDriv } from '@hypdriv/hono';
 *
 * const app = new Hono();
 * useHypDriv(app, { config: { site: { name: 'my-api' } } });   // first, so it wraps everything after it
 * app.get('/', (c) => c.text('hello'));
 * export default app;
 * ```
 *
 * or around the whole app, forwarding the pipeline's request:
 *
 * ```ts
 * import { wrapHono } from '@hypdriv/hono';
 * export default wrapHono(app, { config });
 * ```
 */

export {
  defer,
  flag,
  type GeoInfo,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requireHyp,
} from '@hypdriv/runtime';
export { type HonoAppLike, type WrappedHonoApp, wrapHono } from './app';
export { type HonoManifestOptions, type HonoRoutesSource, honoManifest, honoPattern } from './manifest';
export {
  HOST_LABEL,
  type HypDrivHonoMiddleware,
  type HypDrivHonoOptions,
  type HypDrivHonoVariables,
  hypdriv,
  platformInput,
  useHypDriv,
} from './middleware';

/**
 * `@hypdriv/express` — Hypdriv for Express 5 on Node, Vercel Functions and Cloudflare Workers (`nodejs_compat`).
 *
 * ```ts
 * import express from 'express';
 * import { useHypDriv } from '@hypdriv/express';
 * import config from '../hypdriv.config';
 *
 * const app = express();
 * useHypDriv(app, { config });          // first, so it wraps everything registered after it
 * app.get('/', (req, res) => res.send('hello'));
 * app.listen(3000);
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
export { ResponseCapture } from './capture';
export { type ExpressFetchOptions, type ExpressHandler, expressFetch } from './fetch';
export {
  type ExpressLayerLike,
  type ExpressManifestOptions,
  type ExpressRoutes,
  type ExpressRoutesSource,
  expressManifest,
  expressPattern,
  expressRoutes,
} from './manifest';
export {
  type ExpressAppLike,
  HOST_LABEL,
  type HypDrivExpressLocals,
  type HypDrivExpressMiddleware,
  type HypDrivExpressOptions,
  hypdriv,
  useHypDriv,
} from './middleware';
export { checkOrder } from './order';
export { type WebHandlerOptions, webHandler } from './web-handler';

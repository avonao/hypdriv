/**
 * `@hypdriv/fastify` — Hypdriv for Fastify 5 on Node and Vercel Functions.
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { hypdriv } from '@hypdriv/fastify';
 * import config from '../hypdriv.config';
 *
 * const app = Fastify();
 * await app.register(hypdriv, { config });   // first, so it wraps everything registered after it
 * app.get('/', async () => 'hello');
 * await app.listen({ port: 3000 });
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
export {
  HOST_LABEL,
  type HypDrivFastifyDecoration,
  type HypDrivFastifyOptions,
  hypdriv,
} from './plugin';
export { applyResponse, payloadResponse } from './response';
export {
  type FastifyManifestOptions,
  fastifyManifest,
  fastifyPattern,
  routesFromTree,
} from './routes';
export { type WebRouteOptions, webRoute } from './web-route';

/**
 * `@hypdriv/sveltekit` — HypDriv for SvelteKit 3. `hypdriv(adapter())` wraps the SvelteKit adapter in
 * `vite.config.ts`; `@hypdriv/sveltekit/hooks` is the `handle` hook; `@hypdriv/sveltekit/server` has the request
 * helpers for server code; `@hypdriv/sveltekit/worker` is the Cloudflare Worker shell the build generates an entry
 * for; `@hypdriv/sveltekit/node` serves an adapter-node build with the pipeline in front of every response.
 */
export {
  type HypDrivSvelteKitOptions,
  hypdriv,
  kitCsp,
  type SvelteKitTarget,
  targetOf,
  VIRTUAL_SVELTEKIT,
} from './adapter';
export { parseClientEntry, parseNodeAssets, parseRouteNodes, routeAssets } from './assets';
export { type BuilderLike, builderLogger, type PreparedBuild, prepareBuild } from './build';
export {
  adoptSvelteKitCsp,
  policyNonce,
  quoteSource,
  replaceInStream,
  type SvelteKitCsp,
  svelteKitDirectives,
  withSvelteKitCsp,
} from './csp';
export { absolutizeAssetUrls, mergeMetaHashes, metaCspHashes, stageDocuments } from './documents';
export {
  approximateRegex,
  discoverRoutes,
  type RoutesFromBuilderInput,
  routesFromBuilder,
  type SvelteKitPattern,
  type SvelteKitRouteLike,
  svelteKitPattern,
} from './routes';
export {
  type CloudflareLayout,
  cloudflareLayout,
  isPagesBuild,
  readWranglerConfig,
  SVELTEKIT_WORKER,
  type WranglerConfigLike,
  wrapWorker,
} from './targets/cloudflare';
export { placeHeaderRoutes, writeVercelHeaders } from './targets/vercel';

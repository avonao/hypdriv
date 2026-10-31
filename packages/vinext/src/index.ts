/**
 * `@hypdriv/vinext` — HypDriv for vinext, Cloudflare's Vite implementation of the Next.js API. `hypdriv()` is
 * the Vite plugin (request hook around vinext's App Router handler, build manifest, static headers per
 * platform); `withHypDrivCache()` keeps HypDriv's edge cache in step with `revalidateTag()`.
 *
 * Runtime entry points: `@hypdriv/vinext/server` (`hyp()`, `nonce()`, `flag()`…), `@hypdriv/vinext/worker`
 * (the Cloudflare Worker entry with `scheduled` / `queue` / Durable Objects), `@hypdriv/vinext/proxy`
 * (`proxy.ts` for Pages Router apps), `@hypdriv/vinext/cache` and `@hypdriv/vinext/runtime`.
 */
export {
  type CacheAdapterDescriptorLike,
  cdnAdapterId,
  cdnAdapterModuleCode,
  parseCdnAdapterId,
  VIRTUAL_CDN_ADAPTER,
  type VinextCacheConfigLike,
  withHypDrivCache,
} from './cache-config';
export { PRERENDER_TOKEN_DEFINE, PRERENDER_TOKEN_ENV } from './constants';
export { vercelFallbackDestination, writeVercelStaticPages } from './outputs';
export {
  type HypDrivVinextOptions,
  hookModuleCode,
  hypdriv,
  VINEXT_RSC_ENTRY,
  VIRTUAL_HOOK,
  type VinextTarget,
} from './plugin';
export {
  explicitTags,
  fileDigest,
  type PrerenderedPage,
  prerenderedPages,
  prerenderOutputPath,
  readPrerenderManifest,
  staticCacheDigests,
  type VinextPrerenderManifest,
  type VinextPrerenderRoute,
} from './prerender';
export {
  appSegment,
  discoverAppRoutes,
  discoverPagesRoutes,
  discoverRoutes,
  findRouterDirs,
  fromVinextPattern,
  PAGE_EXTENSIONS,
  type RouterDirs,
  readSegmentConfig,
  type SegmentConfig,
} from './routes';

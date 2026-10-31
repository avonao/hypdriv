/**
 * `@hypdriv/tanstack-start/vite` — the build side of Hypdriv for TanStack Start: `withHypDriv()` for the options of
 * `tanstackStart()` and the `hypdriv()` Vite plugin (route discovery, the manifest after prerendering, static
 * headers per platform, the final manifest patched into the server output).
 *
 * ```ts
 * // vite.config.ts
 * import { hypdriv, withHypDriv } from '@hypdriv/tanstack-start/vite';
 * export default defineConfig({
 *   plugins: [tanstackStart(withHypDriv({ prerender: { enabled: true } })), viteReact(), hypdriv()],
 * });
 * ```
 */
export { PRERENDER_HEADER } from '../constants';
export { type ClientChunk, clientChunksFrom, type OutputChunkLike, routeSources } from './assets';
export { documentsWithNonce, findDocuments, type StartDocument } from './documents';
export {
  prerenderToken,
  resetStartRegistration,
  type StartOptionsLike,
  type StartPrerenderOptionsLike,
  type StartRegistration,
  startRegistration,
  withHypDriv,
} from './options';
export { type HypDrivStartPluginOptions, hypdriv, packageVersion } from './plugin';
export {
  crawlStartRoutes,
  generatorConfig,
  isServerOnly,
  readOnlyGeneratorFs,
  routerBasePath,
  type StartRoute,
  serverFnPattern,
  startRoutesFromNodes,
  toDiscoveredRoutes,
} from './routes';
export {
  type NitroLike,
  type NitroModuleLike,
  nodeRouteRules,
  type StartTarget,
  scrubPrerenderToken,
  targetForNitroPreset,
  writeVercelOverrides,
} from './targets';

/**
 * `@hypdriv/react-router` — HypDriv for React Router (framework mode). The build side lives here: `hypdriv()`, the
 * Vite plugin, and `hypdrivPreset()`, the React Router preset that finalises the manifest and writes the platform
 * output after prerendering. The runtime lives in `@hypdriv/react-router/server` (root middleware, server entry,
 * helpers), `/entry.server` (CSP nonces), `/cloudflare` (Worker entry) and `/node` (production server).
 */
export {
  clientFiles,
  documentPathname,
  eraseToken,
  finalizeReactRouterBuild,
  type ReactRouterBuildInput,
  type ReactRouterBuildResult,
  type ViteConfigLike,
} from './build';
export {
  detectTarget,
  type HypDrivReactRouterOptions,
  hasCloudflarePlugin,
  hypdriv,
  serverEntryCode,
} from './plugin';
export { type HypDrivPresetOptions, hypdrivPreset } from './preset';
export {
  type BrowserManifest,
  type BrowserManifestRoute,
  basenamePrefix,
  branchAssets,
  type DiscoverInput,
  type DiscoverResult,
  discoverRoutes,
  parseBrowserManifest,
  type RouteManifestEntryLike,
  readBrowserManifest,
  routePath,
  routePattern,
  sourceRendersUi,
} from './routes';
export {
  HOST,
  isPrerenderRequest,
  PRERENDER_HEADER,
  VIRTUAL_REACT_ROUTER,
  VIRTUAL_SERVER_ENTRY,
} from './shared';
export type { ReactRouterTarget } from './state';
export {
  type BuildManifestLike,
  bundleConfig,
  type ReactRouterVercelOutputInput,
  type ServerBundleInfo,
  serverBundlesOf,
  traceFunctionFiles,
  VERCEL_LAUNCHER,
  writeReactRouterVercelOutput,
} from './vercel';

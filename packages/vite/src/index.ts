/**
 * `@hypdriv/vite` — HypDriv for Vite. `hypdriv()` is the plugin for plain Vite apps; the rest is the toolkit the
 * framework integrations (`@hypdriv/react-router`, `@hypdriv/tanstack-start`, `@hypdriv/astro`,
 * `@hypdriv/sveltekit`, `@hypdriv/nuxt`, `@hypdriv/vinext`) are built from: config and manifest virtual modules,
 * manifest finalisation, static headers per platform and the post-build manifest patch.
 */
export { connectMiddleware, isViteInternal } from './dev';
export {
  assetFileFor,
  developmentManifest,
  type FinalizeInput,
  type FinalizeResult,
  finalizeManifest,
  type PrerenderedDocument,
} from './finalize';
export {
  configModuleCode,
  type HostPluginApi,
  type HostPluginOptions,
  hostPlugin,
  type LoadedHypConfig,
  loadHypConfig,
  MANIFEST_SENTINEL_KEY,
  MANIFEST_SENTINEL_VALUE,
  manifestModuleCode,
  patchRuntimeManifest,
  replaceRuntimeManifest,
  toModuleSource,
  VIRTUAL_CONFIG,
  VIRTUAL_MANIFEST,
} from './host';
export { type HypDrivPluginOptions, htmlPathname, hypdriv, type ViteTarget, viteLogger } from './plugin';
export {
  type DiscoveredRoute,
  fromColonPath,
  fromSvelteKitId,
  fromTanStackPath,
  fromVueRouterPath,
  isDynamicPattern,
  normalizePathname,
  toHypRoute,
} from './routes';
export {
  ensureAssetsIgnore,
  PRIVATE_BUILD_FILES,
  rulesFor,
  writeCloudflareStatic,
  writeVercelStatic,
} from './targets';
export { buildVercelMiddleware, vercelNodeRuntime, writeVercelOutput } from './vercel-output';
export {
  assetsForEntries,
  entriesForSources,
  readViteManifest,
  type ViteManifest,
  type ViteManifestChunk,
} from './vite-manifest';

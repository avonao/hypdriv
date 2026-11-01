/**
 * `@hypdriv/solid-start/vite` — the Vite plugin for SolidStart 2, built from the `@hypdriv/vite` toolkit:
 *
 * ```ts
 * // vite.config.ts
 * import { solidStart } from '@solidjs/start/config';
 * import { hypdriv } from '@hypdriv/solid-start/vite';
 * import { nitro } from 'nitro/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({ plugins: [solidStart(), nitro(), hypdriv()] });
 * ```
 */
export { documentsWithNonce, findDocuments, type StartDocument } from './documents';
export { applyNodeRouteRules, installNitroModule, nitroPluginPath, optionsSource } from './nitro-module';
export { chunkKeys, type HypDrivSolidStartOptions, hypdriv } from './plugin';
export {
  DEFAULT_EXTENSIONS,
  HTTP_METHODS,
  type ModuleExports,
  moduleExports,
  type RouteLayout,
  resolveLayout,
  routeId,
  type SolidRoute,
  type SolidRouteFile,
  scanRouteFiles,
  solidRoutes,
  toDiscoveredRoutes,
  toPattern,
  usesServerFunctions,
} from './routes';
export {
  type NitroLike,
  type NitroModuleLike,
  nodeRouteRules,
  type SolidStartTarget,
  targetForNitroPreset,
} from './target';
export { writeVercelOverrides } from './vercel';

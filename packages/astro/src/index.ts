/**
 * `@hypdriv/astro` — HypDriv for Astro 7. The default export is the Astro integration:
 *
 * ```js
 * // astro.config.mjs
 * import hypdriv from '@hypdriv/astro';
 * export default defineConfig({ adapter: cloudflare(), integrations: [hypdriv()] });
 * ```
 *
 * Request helpers for pages, endpoints and components are in `@hypdriv/astro/server`; `@hypdriv/astro/fetch` wraps a
 * `src/fetch.ts` so the pipeline also covers what Astro answers before middleware.
 */
import { hypdriv } from './integration';

export {
  addErrorRouteHeaders,
  classifyGeneratedFiles,
  existingCloudflareHeaders,
  type FinalizeAstroInput,
  type FinalizeAstroResult,
  finalizeAstroBuild,
  type GeneratedFile,
  type NodeHeadersEntry,
  nodeHeadersEntries,
  pageFile,
  withBasePath,
  withoutDuplicateHeaders,
} from './build';
export {
  type AstroContextLike,
  type AstroHandlerOptions,
  type AstroHookOptions,
  type AstroNext,
  createAstroHandler,
  createOnRequest,
  isErrorPagePass,
  ONCE_PER_REQUEST_STAGES,
} from './hook';
export {
  adapterTarget,
  astroLogger,
  effectiveConfig,
  type HypDrivAstroOptions,
  hypdriv,
} from './integration';
export {
  type AstroManifestRouteLike,
  type AstroRouteLike,
  type AstroRoutePart,
  astroPattern,
  fromAstroRoutes,
  isHypDrivRoute,
  sourcesFromSsrManifest,
} from './routes';
export {
  type AstroBuildFacts,
  type AstroTarget,
  astroModuleCode,
  astroVitePlugin,
  cspOverlayCode,
  PRERENDER_ENVIRONMENT,
  VIRTUAL_ASTRO,
} from './vite';

export default hypdriv;

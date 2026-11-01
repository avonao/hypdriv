/**
 * `@hypdriv/nitro` — Hypdriv for Nitro 2 (`nitropack`) and Nitro 3 (`nitro`). Add the module and Hypdriv runs its
 * Drivetrain (security headers, CSP nonces and hashes, rate limiting, bot shield, geo, flags, i18n, redirects,
 * maintenance, Early Hints, logging, tracing, Server-Timing, `/_hypdriv/*`) around every Nitro response, on
 * Cloudflare Workers, Vercel and Node:
 *
 * ```ts
 * // nitro.config.ts
 * import { defineConfig } from 'nitro';
 * import { hypdrivNitro } from '@hypdriv/nitro';
 *
 * export default defineConfig({ modules: [hypdrivNitro()] });
 * ```
 *
 * It is also the shared Nitro layer of the framework hosts built on Nitro (`@hypdriv/analog`). Server code reads the
 * request context from `@hypdriv/nitro/server`.
 */
export type { NitroMajor } from './build/cloudflare';
export {
  assertFinalized,
  completeNitroOutput,
  type FinalizeNitroInput,
  finalizeNitroManifest,
  type NitroOutputInput,
  type NitroOutputResult,
  type PrerenderedRoute,
  prerenderedDocuments,
  runtimeManifestFiles,
} from './build/finalize';
export {
  type DiscoverRoutesInput,
  discoverNitroRoutes,
  fromNitroRoute,
  isInternalRoute,
  type NitroHandlerLike,
  type NitroRendererLike,
  rendererRoute,
  type ServerRoutesOptions,
  serverRoutes,
} from './build/routes';
export {
  isDevPreset,
  isPrerenderPreset,
  isStaticPreset,
  type NitroTarget,
  supportsWorkerEntry,
  targetOfPreset,
} from './build/targets';
export {
  type HypdrivNitroOptions,
  hypdrivNitro,
  type NitroLike,
  type NitroModuleLike,
  nitroMajor,
  type RouteDiscoveryContext,
  withHypDriv,
} from './module';
export { FACTS_KEY, type HypEventContext, type HypFacts } from './runtime/facts';

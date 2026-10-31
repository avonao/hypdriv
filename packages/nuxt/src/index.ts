/**
 * `@hypdriv/nuxt` — Hypdriv for Nuxt 4. Add the module and Hypdriv runs its Drivetrain (security headers, CSP
 * nonces and hashes, rate limiting, bot shield, geo, flags, i18n, redirects, maintenance, Early Hints, logging,
 * tracing, Server-Timing, `/_hypdriv/*`) around every Nitro response, on Cloudflare Workers, Vercel and Node:
 *
 * ```ts
 * // nuxt.config.ts
 * export default defineNuxtConfig({ modules: ['@hypdriv/nuxt'] });
 * ```
 *
 * Server code reads the request context from `@hypdriv/nuxt/server`; components use the auto-imported `useHyp()`.
 */
export {
  discoverRoutes,
  type FlatPage,
  flattenPages,
  fromNitroRoute,
  type NitroHandlerLike,
  type NuxtPageLike,
  pageRoutes,
  serverRoutes,
} from './build/routes';
export { isStaticPreset, type NuxtTarget, supportsWorkerEntry, targetOfPreset } from './build/targets';
export { default, type ModuleOptions } from './module';
export type { HypEventContext, HypFacts } from './runtime/facts';

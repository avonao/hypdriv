/**
 * `@hypdriv/nuxt/server` — Hypdriv's request context for Nitro server code (API routes, server middleware,
 * server utilities). Every request below the Hypdriv hook runs inside its `AsyncLocalStorage` context:
 *
 * ```ts
 * // server/api/whoami.get.ts
 * import { defineEventHandler } from 'nuxt/server';
 * import { flag, hyp } from '@hypdriv/nuxt/server';
 *
 * export default defineEventHandler(() => ({ requestId: hyp()?.requestId, newHero: flag('newHero', false) }));
 * ```
 *
 * In Vue components use the `useHyp()` / `useHypNonce()` composables the module auto-imports instead: this entry
 * is server-only.
 */
export {
  defer,
  flag,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requireHyp,
} from '@hypdriv/runtime';
export type { HypEventContext, HypFacts } from './runtime/facts';

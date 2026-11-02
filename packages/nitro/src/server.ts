/**
 * `@hypdriv/nitro/server` — Hypdriv's request context for Nitro server code (route handlers, middleware, error
 * handlers, utilities). Every request below the Hypdriv hook runs inside its `AsyncLocalStorage` context:
 *
 * ```ts
 * // routes/api/whoami.ts
 * import { defineHandler } from 'nitro';
 * import { flag, hyp } from '@hypdriv/nitro/server';
 *
 * export default defineHandler(() => ({ requestId: hyp()?.requestId, newHero: flag('newHero', false) }));
 * ```
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
export { FACTS_KEY, type HypEventContext, type HypFacts } from './runtime/facts';

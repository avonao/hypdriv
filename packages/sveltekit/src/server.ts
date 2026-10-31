/**
 * `@hypdriv/sveltekit/server` — HypDriv's request helpers for server code below the `handle` hook: `load`
 * functions, form actions, `+server` endpoints, remote functions and server-rendered components.
 *
 * ```ts
 * // src/routes/+page.server.ts
 * import { flag, hyp } from '@hypdriv/sveltekit/server';
 * export const load = () => ({ requestId: hyp()?.requestId, newHero: flag('newHero', false) });
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

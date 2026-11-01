/**
 * `@hypdriv/qwik/server` — request helpers for server code below the Drivetrain: `routeLoader$`, `routeAction$`,
 * `server$` functions, middleware (`onRequest`) and endpoints. They read the request the pipeline is handling, so
 * call them while Qwik handles it (not from code that runs in the browser).
 *
 * ```tsx
 * import { flag, geo, hyp, nonce } from '@hypdriv/qwik/server';
 *
 * export const useHero = routeLoader$(() => ({ variant: flag('newHero', false) ? 'new' : 'classic' }));
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

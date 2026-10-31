/**
 * `@hypdriv/tanstack-start/server` — Hypdriv's request helpers for server code below the Hypdriv middleware:
 * server functions (`createServerFn().handler`), server routes (`server.handlers`), request middleware, and SSR
 * code inside `createIsomorphicFn().server()`.
 *
 * ```ts
 * import { flag, hyp } from '@hypdriv/tanstack-start/server';
 * export const getFacts = createServerFn().handler(() => ({ id: hyp()?.requestId, hero: flag('newHero', false) }));
 * ```
 *
 * Route loaders are isomorphic (they also run in the browser on client-side navigations): call these helpers from
 * a server function the loader invokes. In the browser this entry resolves to stand-ins that report "no request".
 */
export {
  defer,
  flag,
  type GeoInfo,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requireHyp,
} from '@hypdriv/runtime';

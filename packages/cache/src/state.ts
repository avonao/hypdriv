import { type StateKey, stateKey } from '@hypdriv/core';
import type { CacheDecision } from './types';

/** Written by the `edge-cache` stage for every request (also DYNAMIC/BYPASS outcomes). */
export const CACHE_DECISION_KEY: StateKey<CacheDecision> = stateKey<CacheDecision>('cache.decision');

/** Signature of the upstream render function a runner exposes to stages. */
export type UpstreamFetch = (request: Request) => Promise<Response>;

/**
 * The upstream (Next.js) render function, set by the runner before the pipeline runs:
 *
 * ```ts
 * ctx.state.set(UPSTREAM_KEY, (req) => nextWorker.fetch(req, env, execCtx));
 * await runPipeline({ stages, ctx, next: (req) => ctx.state.get(UPSTREAM_KEY)!(req) });
 * ```
 *
 * The edge-cache stage needs it for background revalidation (stale-while-revalidate) and, when the
 * runner reads it at call time as shown above, wraps it per request so that upstream exceptions can be
 * answered with a stale-if-error entry and coalesced followers are released immediately. Runners that
 * call `next` directly keep stale-while-revalidate but must call `edgeCache.recover(ctx)` in their
 * error handler to get stale-if-error on exceptions.
 */
export const UPSTREAM_KEY: StateKey<UpstreamFetch> = stateKey<UpstreamFetch>('upstream');

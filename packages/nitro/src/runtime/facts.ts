import type { HypContext } from '@hypdriv/core';
import { publicFlags } from '@hypdriv/flags';
import { requestContextFrom } from '@hypdriv/runtime';

/** The `event.context` key under which the integration hands request facts to the application. */
export const FACTS_KEY = 'hypdriv';

/**
 * Facts about the current request that are safe to render and to serialise into a page (no secrets, server-only
 * flags filtered out). Framework helpers (`useHyp()` in Nuxt, the `HYP_FACTS` token of `@hypdriv/analog`) return
 * them.
 */
export interface HypFacts {
  requestId: string;
  /** `host` (the Nitro hook ran the pipeline) or `worker` (Hypdriv's Cloudflare Worker entry did). */
  runner: string;
  /** The matched manifest route id. */
  route: string | null;
  country: string | null;
  locale: string | null;
  /** The CSP mode the pipeline chose (`nonce`, `hash`, …) when it is known before rendering. */
  cspMode: string | null;
  /** Edge-evaluated flags, without the ones defined as `serverOnly`. */
  flags: Record<string, string | number | boolean>;
}

/** What the integration stores on `event.context.hypdriv`. */
export interface HypEventContext extends HypFacts {
  /**
   * The request's CSP nonce, when the application may stamp it on the tags it renders. Absent when the render is
   * cached by Nitro (`cache`/`swr` route rules): a cached document must not carry one request's nonce, the
   * pipeline injects the current one into the response instead.
   */
  nonce?: string;
}

/** Request facts for the application, stored on `event.context.hypdriv`. */
export function factsFor(ctx: HypContext, options: { nonce: boolean }): HypEventContext {
  const view = requestContextFrom(ctx);
  return {
    requestId: view.requestId,
    runner: view.runner,
    route: view.route,
    country: view.country,
    locale: view.locale,
    cspMode: view.cspMode,
    flags: publicFlags(view.flags, ctx.config.flags.definitions),
    ...(options.nonce && view.nonce ? { nonce: view.nonce } : {}),
  };
}

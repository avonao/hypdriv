/** The `event.context` key under which the integration hands request facts to the Nuxt app. */
export const FACTS_KEY = 'hypdriv';

/**
 * Facts about the current request that are safe to render and to serialise into Nuxt's payload (no secrets,
 * server-only flags filtered out). `useHyp()` returns them in components.
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
   * The request's CSP nonce, when Nuxt may stamp it on the tags it renders. Absent when the render is cached by
   * Nitro (`cache`/`swr` route rules): a cached document must not carry one request's nonce, the pipeline injects
   * the current one into the response instead.
   */
  nonce?: string;
}

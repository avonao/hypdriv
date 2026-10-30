/** What `purgeEdge()` needs from the edge cache (implemented by `EdgeCache`). */
export interface EdgePurger {
  purgeTags(tags: string[]): Promise<number | void>;
  purgeUrls(urls: string[]): Promise<number | void>;
}

const KEY = Symbol.for('hypdriv.edge-purger');

/**
 * Registers the per-isolate edge cache purger. The Worker shell and `createProxy` call this at startup so
 * `revalidateTag()` / `purgeEdge()` from `@hypdriv/next/cache` purge the same cache. Lives here (and not in
 * `@hypdriv/next`) so the Worker entry never imports Next.js modules.
 */
export function registerEdgePurger(purger: EdgePurger | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = purger ?? undefined;
}

/** The registered edge purger, if any. */
export function getEdgePurger(): EdgePurger | undefined {
  return (globalThis as Record<symbol, unknown>)[KEY] as EdgePurger | undefined;
}

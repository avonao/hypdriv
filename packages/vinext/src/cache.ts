import { getEdgePurger, pathTag } from '@hypdriv/cache';
import { getCurrentContext, platformWaitUntil } from '@hypdriv/core';

/**
 * `@hypdriv/vinext/cache` — keeps Hypdriv's edge cache (or the platform purger Hypdriv registered, such as
 * Vercel's CDN) in sync with vinext's `revalidateTag()` / `revalidatePath()`. vinext calls the configured CDN
 * cache adapter's `revalidateTag(tags, durations)` after the data cache invalidated its entries; the adapter
 * `withHypDrivCache()` installs forwards the call to the application's adapter and then purges Hypdriv's caches.
 */

/** The `revalidateTag` part of vinext's `CdnCacheAdapter` (the rest of the adapter is passed through). */
export interface CdnCacheAdapterLike {
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  [key: string]: unknown;
}

/** Tag prefix vinext (like Next.js) uses for path invalidations: `revalidatePath('/blog')` → `_N_T_/blog`. */
export const IMPLICIT_TAG_PREFIX = '_N_T_';

/**
 * Next.js applies tag invalidations at the end of the Route Handler or Server Action; a request between the
 * first purge and that commit can re-cache the old page. Hypdriv purges again after this delay (as
 * `@hypdriv/next/cache` does).
 */
export const REPURGE_DELAY_MS = 2000;

/**
 * Maps vinext invalidation tags to Hypdriv's edge-cache tags and URLs. Application tags (`products`) purge
 * entries carrying the same policy tag; path tags (`_N_T_/blog`, `_N_T_/blog/page`, `_N_T_/blog/layout`)
 * purge the page's `path:` tag and, when the request origin is known, its URL.
 */
export function purgeTargets(
  tags: string | string[],
  origin?: string | null,
): { tags: string[]; urls: string[] } {
  const list = Array.isArray(tags) ? tags : [tags];
  const outTags = new Set<string>();
  const urls = new Set<string>();
  for (const tag of list) {
    if (typeof tag !== 'string' || !tag) continue;
    if (!tag.startsWith(IMPLICIT_TAG_PREFIX)) {
      outTags.add(tag);
      continue;
    }
    let path = tag.slice(IMPLICIT_TAG_PREFIX.length) || '/';
    if (!path.startsWith('/')) continue;
    // Segment tags: `/blog/page` and `/blog/layout` belong to `/blog`; the root layout is `/`.
    path = path.replace(/\/(?:page|layout)$/, '') || '/';
    const byPath = pathTag(path);
    if (byPath) outTags.add(byPath);
    if (origin) urls.add(`${origin}${path === '/' ? '/' : path}`);
  }
  return { tags: [...outTags], urls: [...urls] };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Purges Hypdriv's edge cache (the purger the Hypdriv handler or Worker registered) for vinext invalidation
 * tags, now and once more after {@link REPURGE_DELAY_MS}. Returns false when no purger is registered (no edge
 * cache in this runtime).
 */
export async function purgeHypDriv(tags: string | string[]): Promise<boolean> {
  const purger = getEdgePurger();
  if (!purger) return false;
  const ctx = getCurrentContext();
  const targets = purgeTargets(tags, ctx?.url.origin);
  if (!targets.tags.length && !targets.urls.length) return true;
  const purge = async () => {
    if (targets.tags.length) await purger.purgeTags(targets.tags);
    if (targets.urls.length) await purger.purgeUrls(targets.urls);
  };
  await purge();
  const repeat = delay(REPURGE_DELAY_MS)
    .then(purge)
    .catch((err: unknown) =>
      ctx?.log.warn('hypdriv: repeat edge purge failed', { error: (err as Error)?.message }),
    );
  if (ctx) ctx.waitUntil(repeat);
  else platformWaitUntil()?.(repeat);
  return true;
}

/**
 * Wraps a vinext CDN cache adapter so `revalidateTag` also purges Hypdriv's caches. Every other member (and
 * `this` for class-based adapters) is the adapter's own.
 */
export function withHypDrivPurge<A extends object>(adapter: A): A {
  const own = adapter as unknown as CdnCacheAdapterLike;
  const revalidateTag = async (tags: string | string[], durations?: { expire?: number }): Promise<void> => {
    await own.revalidateTag.call(adapter, tags, durations);
    try {
      await purgeHypDriv(tags);
    } catch (err) {
      getCurrentContext()?.log.warn('hypdriv: edge purge after revalidateTag failed', {
        error: (err as Error)?.message,
      });
    }
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'revalidateTag') return revalidateTag;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

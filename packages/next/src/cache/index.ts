import { getEdgePurger, pathTag } from '@hypdriv/cache';
import { getCurrentContext, platformWaitUntil, readEnv } from '@hypdriv/core';

export { type EdgePurger, getEdgePurger, registerEdgePurger } from '@hypdriv/cache';

async function zonePurge(body: Record<string, unknown>): Promise<boolean> {
  const ctx = getCurrentContext();
  const env = ctx?.env ?? {};
  const zoneId = readEnv(env, 'CACHE_PURGE_ZONE_ID');
  const token = readEnv(env, 'CACHE_PURGE_API_TOKEN');
  if (!zoneId || !token) return false;
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

/** Purges Hypdriv's edge cache (and the Cloudflare zone cache when credentials exist) by tags or URLs. */
export async function purgeEdge(options: {
  tags?: string[];
  urls?: string[];
}): Promise<{ edge: boolean; zone: boolean }> {
  const purger = getEdgePurger();
  let edge = false;
  if (purger) {
    if (options.tags?.length) await purger.purgeTags(options.tags);
    if (options.urls?.length) await purger.purgeUrls(options.urls);
    edge = true;
  }
  let zone = false;
  if (!purger) {
    if (options.tags?.length) zone = (await zonePurge({ tags: options.tags })) || zone;
    if (options.urls?.length) zone = (await zonePurge({ files: options.urls })) || zone;
  }
  return { edge, zone };
}

/**
 * Next.js applies `revalidateTag()` / `revalidatePath()` after the Route Handler or Server Action returns
 * (pending revalidations run in `waitUntil`), so a request between the first edge purge and that commit can
 * re-cache the old page. The edge cache purges again after this delay; with a Durable Object tag index the
 * purge tombstones already cover the window (`purgeGraceMs`), elsewhere the second purge does.
 */
export const REPURGE_DELAY_MS = 2000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function purgeTwice(options: { tags?: string[]; urls?: string[] }): Promise<void> {
  await purgeEdge(options);
  await delay(REPURGE_DELAY_MS);
  await purgeEdge(options);
}

/**
 * Keeps the repeat purge alive after the response: the Hypdriv request context, else the platform's
 * `waitUntil` (Vercel Functions, where Route Handlers and Server Actions run outside the proxy's context).
 */
function schedule(task: Promise<unknown>): void {
  const settled = task.catch(() => undefined);
  const ctx = getCurrentContext();
  if (ctx) {
    ctx.waitUntil(settled);
    return;
  }
  platformWaitUntil()?.(settled);
}

type NextCache = {
  revalidateTag: (tag: string, profile?: unknown) => void | Promise<void>;
  revalidatePath: (path: string, type?: 'page' | 'layout') => void | Promise<void>;
};

async function nextCache(): Promise<NextCache> {
  return (await import('next/cache')) as unknown as NextCache;
}

/**
 * `revalidateTag` from `next/cache` followed by an edge purge of the same tag (repeated once Next has
 * applied the revalidation, see `REPURGE_DELAY_MS`), so Hypdriv's edge cache and Next's data cache stay in
 * sync. Accepts Next 16's cache-life profile argument.
 */
export async function revalidateTag(tag: string, profile?: unknown): Promise<void> {
  const cache = await nextCache();
  await (profile === undefined ? cache.revalidateTag(tag) : cache.revalidateTag(tag, profile));
  schedule(purgeTwice({ tags: [tag] }));
}

/**
 * `revalidatePath` from `next/cache` followed by an edge purge of the page: its `path:` tag (every cached
 * variant), its route tag and its URL.
 */
export async function revalidatePath(path: string, type?: 'page' | 'layout'): Promise<void> {
  const cache = await nextCache();
  await cache.revalidatePath(path, type);
  const ctx = getCurrentContext();
  const origin = ctx?.url.origin;
  const byPath = pathTag(path);
  schedule(
    purgeTwice({
      tags: [`route:app:${path}`, ...(byPath ? [byPath] : [])],
      ...(origin ? { urls: [`${origin}${path}`] } : {}),
    }),
  );
}

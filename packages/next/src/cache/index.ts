import { getEdgePurger } from '@hypdriv/cache';
import { getCurrentContext, readEnv } from '@hypdriv/core';

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

/** Purges HypDriv's edge cache (and the Cloudflare zone cache when credentials exist) by tags or URLs. */
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

function schedule(task: Promise<unknown>): void {
  const ctx = getCurrentContext();
  if (ctx) ctx.waitUntil(task);
  else void task.catch(() => undefined);
}

type NextCache = {
  revalidateTag: (tag: string, profile?: unknown) => void | Promise<void>;
  revalidatePath: (path: string, type?: 'page' | 'layout') => void | Promise<void>;
};

async function nextCache(): Promise<NextCache> {
  return (await import('next/cache')) as unknown as NextCache;
}

/**
 * `revalidateTag` from `next/cache` followed by an edge purge of the same tag, so HypDriv's edge
 * cache and Next's data cache stay in sync. Accepts Next 16's cache-life profile argument.
 */
export async function revalidateTag(tag: string, profile?: unknown): Promise<void> {
  const cache = await nextCache();
  await (profile === undefined ? cache.revalidateTag(tag) : cache.revalidateTag(tag, profile));
  schedule(purgeEdge({ tags: [tag] }));
}

/** `revalidatePath` from `next/cache` followed by an edge purge of the path and its route tag. */
export async function revalidatePath(path: string, type?: 'page' | 'layout'): Promise<void> {
  const cache = await nextCache();
  await cache.revalidatePath(path, type);
  const ctx = getCurrentContext();
  const origin = ctx?.url.origin;
  schedule(
    purgeEdge({
      tags: [`route:app:${path}`, `path:${path}`],
      ...(origin ? { urls: [`${origin}${path}`] } : {}),
    }),
  );
}

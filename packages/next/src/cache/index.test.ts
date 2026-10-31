import { registerEdgePurger } from '@hypdriv/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeEdge, REPURGE_DELAY_MS, revalidatePath, revalidateTag } from './index';

const nextCache = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('next/cache', () => nextCache);

function fakePurger() {
  const calls: { tags: string[][]; urls: string[][] } = { tags: [], urls: [] };
  const purger = {
    async purgeTags(tags: string[]) {
      calls.tags.push(tags);
      return tags.length;
    },
    async purgeUrls(urls: string[]) {
      calls.urls.push(urls);
      return urls.length;
    },
  };
  registerEdgePurger(purger);
  return calls;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
});

/** Lets the scheduled purges run: the immediate one, then the repeat after REPURGE_DELAY_MS. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(REPURGE_DELAY_MS);
}

describe('revalidateTag / revalidatePath', () => {
  it('revalidates in Next.js, then purges the edge cache by tag', async () => {
    const calls = fakePurger();
    await revalidateTag('posts', 'max');
    expect(nextCache.revalidateTag).toHaveBeenCalledWith('posts', 'max');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.tags).toEqual([['posts']]);
    // Repeated after Next has applied the revalidation (it runs after the handler returns).
    await vi.advanceTimersByTimeAsync(REPURGE_DELAY_MS);
    expect(calls.tags).toEqual([['posts'], ['posts']]);
  });

  it('purges every cached variant of a path through its normalised path tag', async () => {
    const calls = fakePurger();
    await revalidatePath('/blog/hello/');
    expect(nextCache.revalidatePath).toHaveBeenCalledWith('/blog/hello/', undefined);
    await settle();
    expect(calls.tags).toEqual([
      ['route:app:/blog/hello/', 'path:/blog/hello'],
      ['route:app:/blog/hello/', 'path:/blog/hello'],
    ]);
  });

  it('reports which caches were purged', async () => {
    fakePurger();
    expect(await purgeEdge({ tags: ['a'], urls: ['https://x.test/a'] })).toEqual({ edge: true, zone: false });
  });
});

describe('scheduling outside a HypDriv request context', () => {
  it('keeps the repeat purge alive with the platform waitUntil (Vercel Functions)', async () => {
    const calls = fakePurger();
    const pending: Array<Promise<unknown>> = [];
    const slot = Symbol.for('@vercel/request-context');
    (globalThis as Record<symbol, unknown>)[slot] = {
      get: () => ({ waitUntil: (p: Promise<unknown>) => void pending.push(p) }),
    };
    try {
      await revalidateTag('catalog');
      expect(pending).toHaveLength(1);
      await settle();
      await pending[0];
      expect(calls.tags).toEqual([['catalog'], ['catalog']]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[slot];
    }
  });
});

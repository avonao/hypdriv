import { type EdgePurger, registerEdgePurger } from '@hypdriv/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purgeHypDriv, purgeTargets, withHypDrivPurge } from './cache';
import { cdnAdapterId, cdnAdapterModuleCode, parseCdnAdapterId, withHypDrivCache } from './cache-config';

afterEach(() => {
  registerEdgePurger(null);
  vi.useRealTimers();
});

function fakePurger() {
  const calls: Array<['tags' | 'urls', string[]]> = [];
  const purger: EdgePurger = {
    async purgeTags(tags) {
      calls.push(['tags', tags]);
    },
    async purgeUrls(urls) {
      calls.push(['urls', urls]);
    },
  };
  return { purger, calls };
}

describe('purge targets', () => {
  it('maps vinext tags to Hypdriv edge-cache tags and URLs', () => {
    expect(
      purgeTargets(['products', '_N_T_/blog', '_N_T_/blog/page', '_N_T_/layout'], 'https://ex.com'),
    ).toEqual({
      tags: ['products', 'path:/blog', 'path:/'],
      urls: ['https://ex.com/blog', 'https://ex.com/'],
    });
    expect(purgeTargets('_N_T_/cached')).toEqual({ tags: ['path:/cached'], urls: [] });
  });
});

describe('withHypDrivPurge', () => {
  it('forwards to the adapter (keeping its own `this`) and purges Hypdriv’s edge cache twice', async () => {
    vi.useFakeTimers();
    const { purger, calls } = fakePurger();
    registerEdgePurger(purger);
    class Adapter {
      #purged: string[] = [];
      readonly ownsBackgroundRevalidation = true;
      async revalidateTag(tags: string | string[], _durations?: { expire?: number }) {
        this.#purged.push(...(Array.isArray(tags) ? tags : [tags]));
      }
      purged() {
        return this.#purged;
      }
      buildResponseHeaders() {
        return { 'cache-control': 'x' };
      }
    }
    const inner = new Adapter();
    const wrapped = withHypDrivPurge(inner);
    expect(wrapped.ownsBackgroundRevalidation).toBe(true);
    expect(wrapped.buildResponseHeaders()).toEqual({ 'cache-control': 'x' });
    await wrapped.revalidateTag(['products', '_N_T_/about'], { expire: 0 });
    expect(inner.purged()).toEqual(['products', '_N_T_/about']);
    expect(calls).toEqual([['tags', ['products', 'path:/about']]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
  });

  it('is a no-op for Hypdriv without a registered purger', async () => {
    expect(await purgeHypDriv(['x'])).toBe(false);
    const revalidateTag = vi.fn(
      async (_tags: string | string[], _durations?: { expire?: number }) => undefined,
    );
    await withHypDrivPurge({ revalidateTag }).revalidateTag('x');
    expect(revalidateTag).toHaveBeenCalledWith('x', undefined);
  });
});

describe('withHypDrivCache', () => {
  it('wraps the application’s CDN adapter and keeps its build hooks and capabilities', () => {
    const finalizePrerenderOutput = () => undefined;
    const cache = withHypDrivCache({
      data: { adapter: '/abs/kv.js', options: { binding: 'KV' } },
      cdn: {
        adapter: '@vinext/cloudflare/cache/static-assets-adapter.runtime',
        options: { binding: 'ASSETS' },
        output: { finalizePrerenderOutput },
        capabilities: { buildIdentity: 'response-header', warmup: 'data-cache' },
      },
    });
    expect(cache.data).toEqual({ adapter: '/abs/kv.js', options: { binding: 'KV' } });
    expect(cache.cdn.options).toEqual({ inner: { binding: 'ASSETS' } });
    expect((cache.cdn.output as { finalizePrerenderOutput: unknown }).finalizePrerenderOutput).toBe(
      finalizePrerenderOutput,
    );
    expect(cache.cdn.capabilities).toEqual({ buildIdentity: 'response-header', warmup: 'data-cache' });
    expect(parseCdnAdapterId(cache.cdn.adapter)).toEqual({
      adapter: '@vinext/cloudflare/cache/static-assets-adapter.runtime',
      buildIdentity: false,
    });
    // Idempotent.
    expect(withHypDrivCache(cache)).toBe(cache);
  });

  it('stands in for vinext’s default adapter, keeping the data adapter’s build identity', () => {
    const cache = withHypDrivCache({
      data: { adapter: '/kv.js', capabilities: { buildIdentity: 'response-header', warmup: 'data-cache' } },
    });
    expect(parseCdnAdapterId(cache.cdn.adapter)).toEqual({ adapter: null, buildIdentity: true });
    expect(cache.cdn.capabilities).toEqual({ buildIdentity: 'response-header', warmup: 'data-cache' });
    expect(withHypDrivCache().cdn.adapter).toBe('virtual:hypdriv/vinext-cdn');
  });

  it('generates the adapter module', () => {
    const wrapped = cdnAdapterModuleCode({ adapter: '/abs/adapter.js', buildIdentity: false });
    expect(wrapped).toContain('import inner from "/abs/adapter.js"');
    expect(wrapped).toContain(
      'instantiateCacheAdapter(inner, { env: args?.env, options: args?.options?.inner',
    );
    expect(wrapped).toContain('return withHypDrivPurge(adapter)');
    const fallback = cdnAdapterModuleCode({ adapter: null, buildIdentity: true });
    expect(fallback).toContain('new DefaultCdnCacheAdapter(process.env.__VINEXT_RSC_BUILD_IDENTITY');
    expect(cdnAdapterModuleCode({ adapter: null, buildIdentity: false })).toContain(
      'new DefaultCdnCacheAdapter()',
    );
    expect(parseCdnAdapterId(`\0${cdnAdapterId({ adapter: '/a?b', buildIdentity: true })}`)).toEqual({
      adapter: '/a?b',
      buildIdentity: true,
    });
    expect(parseCdnAdapterId('virtual:other')).toBeNull();
  });
});

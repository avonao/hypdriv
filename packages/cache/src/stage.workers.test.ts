import { createContext, flushContext, resolveConfig, runPipeline } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeManifest, makeRoute } from './__fixtures__/fakes';
import { createEdgeCache } from './stage';
import { CACHE_DECISION_KEY, UPSTREAM_KEY } from './state';
import { createCacheApiStore } from './stores/cache-api';

describe('edge-cache stage inside workerd', () => {
  it('misses, stores through caches.default and hits on the next request', async () => {
    const config = resolveConfig({ cache: { edge: { inferredStatic: { ttl: 60, swr: 120 } } } });
    const slug = crypto.randomUUID();
    const manifest = makeManifest([makeRoute({ pathname: '/blog/[slug]', classification: 'static' })], {
      buildId: `b-${slug}`,
    });
    const edgeCache = createEdgeCache({ store: createCacheApiStore() });
    let renders = 0;

    const run = async () => {
      const request = new Request(`https://x.test/blog/${slug}`);
      const ctx = createContext({
        request,
        config,
        manifest,
        runner: 'worker',
        route: { route: manifest.routes[0]!, params: { slug } },
      });
      ctx.state.set(UPSTREAM_KEY, async () => {
        renders++;
        return new Response(`<p>${slug}</p>`, { headers: { 'content-type': 'text/html' } });
      });
      const result = await runPipeline({
        stages: [edgeCache.stage()],
        ctx,
        next: (req) => ctx.state.get(UPSTREAM_KEY)!(req),
      });
      await flushContext(ctx);
      return { ...result, decision: ctx.state.get(CACHE_DECISION_KEY)! };
    };

    const first = await run();
    expect(first.decision.status).toBe('MISS');
    expect(first.response.headers.get('x-hypdriv-cache')).toBe('MISS');
    expect(await first.response.text()).toBe(`<p>${slug}</p>`);

    const second = await run();
    expect(second.decision).toMatchObject({ status: 'HIT', reason: 'fresh' });
    expect(second.shortCircuitedBy).toBe('edge-cache');
    expect(second.response.headers.get('x-hypdriv-cache')).toBe('HIT');
    expect(second.response.headers.get('age')).toBe('0');
    expect(second.response.headers.get('cache-tag')).toBe(`route:app:/blog/[slug],build:b-${slug}`);
    expect(await second.response.text()).toBe(`<p>${slug}</p>`);
    expect(renders).toBe(1);

    expect(await edgeCache.purgeUrls([`https://x.test/blog/${slug}`])).toBe(1);
    const third = await run();
    expect(third.decision.status).toBe('MISS');
    expect(renders).toBe(2);
  });
});

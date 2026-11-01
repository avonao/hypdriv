import { flushContext, type HypDrivConfig, resolveConfig, runPipeline } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, makeManifest, makeRoute } from './__fixtures__/fakes';
import { serializeCacheKey } from './keys';
import { resolvePolicies } from './policies';
import { createEdgeCache } from './stage';
import { CACHE_DECISION_KEY, UPSTREAM_KEY } from './state';
import { createMemoryStore } from './stores/memory';
import { createMemoryTagIndex } from './tags/memory';
import { createWarmVariantPlanner, enumerateVariantInputs, MAX_PURGE_VARIANTS } from './variants';

const manifest = makeManifest([
  makeRoute({ pathname: '/', classification: 'static' }),
  makeRoute({ pathname: '/pricing', classification: 'dynamic' }),
  makeRoute({ pathname: '/assets-api', classification: 'dynamic' }),
]);

const experiments = {
  checkout: { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
  hero: { default: 'a', experiment: { variants: { a: 1, b: 1, c: 1 } } },
} satisfies NonNullable<HypDrivConfig['flags']>['definitions'];

const config: HypDrivConfig = {
  flags: { definitions: experiments },
  cache: {
    edge: {
      policies: [
        { id: 'pricing', match: '/pricing', ttl: 60 },
        { id: 'api', match: '/assets-api', ttl: 60, vary: { experiments: false } },
      ],
    },
  },
};

describe('variant enumeration', () => {
  const resolved = resolveConfig(config);
  const [pricing, api] = resolved.cache.edge!.policies;

  it('lists every experiment variant combination except the base key', () => {
    const inputs = enumerateVariantInputs(pricing!, resolved);
    // (1 + 2) x (1 + 3) combinations, the empty one is the base key.
    expect(inputs).toHaveLength(11);
    expect(inputs).toContainEqual({ flags: { checkout: 'b', hero: 'c' } });
    expect(inputs).toContainEqual({ flags: { checkout: 'control' } });
    expect(inputs.every((input) => Object.keys(input.flags ?? {}).length > 0)).toBe(true);
  });

  it('has nothing to enumerate for a policy that does not vary on experiments', () => {
    expect(enumerateVariantInputs(api!, resolved)).toEqual([]);
  });

  it('enumerates the declared values of a plain flag, the locales and the device classes', () => {
    const c = resolveConfig({
      flags: {
        definitions: {
          beta: { default: false, rules: [{ percentage: 10, value: true }] },
          theme: { default: 'light', rules: [{ when: { cookie: { t: 'd' } }, value: 'dark' }] },
        },
      },
      i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
      cache: {
        edge: {
          policies: [{ match: '/**', ttl: 60, vary: { flags: ['beta'], language: true, device: true } }],
        },
      },
    });
    const inputs = enumerateVariantInputs(c.cache.edge!.policies[0]!, c);
    // beta: absent/false/true, locale: absent/en/de, device: absent/mobile/desktop.
    expect(inputs).toHaveLength(3 * 3 * 3 - 1);
    expect(inputs).toContainEqual({ flags: { beta: true }, locale: 'de', device: 'mobile' });
    // `theme` is not in the policy's vary list, so it does not multiply the copies.
    expect(inputs.some((input) => input.flags && 'theme' in input.flags)).toBe(false);
  });

  it('gives up (and leaves it to the path tag) above the cap', () => {
    const many: NonNullable<HypDrivConfig['flags']>['definitions'] = {};
    for (let i = 0; i < 5; i++)
      many[`e${i}`] = { default: 'a', experiment: { variants: { a: 1, b: 1, c: 1 } } };
    const c = resolveConfig({
      flags: { definitions: many },
      cache: { edge: { policies: [{ match: '/**', ttl: 60 }] } },
    });
    expect(4 ** 5 - 1).toBeGreaterThan(MAX_PURGE_VARIANTS);
    expect(enumerateVariantInputs(c.cache.edge!.policies[0]!, c)).toEqual([]);
  });
});

describe('warm-up planner', () => {
  const resolved = resolveConfig(config);

  it('covers every variant combination of the experiments a page depends on, the control first', () => {
    const plan = createWarmVariantPlanner(resolved, manifest)('/pricing');
    expect(plan[0]).toEqual({ checkout: 'control', hero: 'a' });
    expect(plan).toHaveLength(6);
    expect(new Set(plan.map((p) => JSON.stringify(p))).size).toBe(6);
  });

  it('warms plain once for pages that do not vary on an experiment or have no policy', () => {
    const plan = createWarmVariantPlanner(resolved, manifest);
    expect(plan('/assets-api')).toEqual([{}]);
    expect(plan('/nowhere')).toEqual([{}]);
  });

  it('is bounded by the copy cap', () => {
    const many: NonNullable<HypDrivConfig['flags']>['definitions'] = {};
    for (let i = 0; i < 5; i++)
      many[`e${i}`] = { default: 'a', experiment: { variants: { a: 1, b: 1, c: 1 } } };
    const c = resolveConfig({
      flags: { definitions: many },
      cache: { edge: { policies: [{ match: '/**', ttl: 60 }] } },
    });
    const plan = createWarmVariantPlanner(c, manifest)('/pricing');
    expect(plan).toHaveLength(16);
    expect(plan[0]).toEqual({ e0: 'a', e1: 'a', e2: 'a', e3: 'a', e4: 'a' });
  });

  it('leaves concluded experiments out', () => {
    const c = resolveConfig({
      flags: {
        definitions: {
          ...experiments,
          checkout: {
            default: 'control',
            experiment: { variants: { control: 1, b: 1 }, status: 'concluded', winner: 'b' },
          },
        },
      },
      cache: { edge: { policies: [{ match: '/pricing', ttl: 60 }] } },
    });
    expect(createWarmVariantPlanner(c, manifest)('/pricing')).toHaveLength(3);
  });
});

describe('Vary for flag-dependent copies', () => {
  it('tells shared caches that the copy depends on the visitor’s cookies', () => {
    const resolved = resolveConfig(config);
    const [pricing, api] = resolved.cache.edge!.policies;
    const keyOf = (policy: typeof pricing) =>
      serializeCacheKey({
        request: new Request('https://x.test/pricing'),
        url: new URL('https://x.test/pricing'),
        policy: policy!,
        buildId: 'b',
        flags: { checkout: 'b', hero: 'a' },
        ignoredQuery: [],
      });
    expect(keyOf(pricing).vary).toEqual(['cookie']);
    expect(keyOf(api).vary).toEqual([]);
    expect(resolvePolicies(resolved, manifest).length).toBeGreaterThan(0);
  });
});

describe('purgeUrls() reaches every experiment variant (finding 6)', () => {
  /** Two isolates: the same shared store, each with its own in-memory tag index. */
  function isolates() {
    const store = createMemoryStore();
    const make = () => {
      const edgeCache = createEdgeCache({
        store,
        tagIndex: createMemoryTagIndex(),
        resolvers: { flags: (ctx) => ({ checkout: ctx.request.headers.get('x-variant') ?? 'control' }) },
      });
      async function request(url: string, variant: string) {
        const ctx = makeCtx(new Request(url, { headers: { 'x-variant': variant } }), { config, manifest });
        const upstream = async () =>
          new Response(`page-${variant}`, { headers: { 'content-type': 'text/html' } });
        ctx.state.set(UPSTREAM_KEY, upstream);
        const result = await runPipeline({
          stages: [edgeCache.stage()],
          ctx,
          next: (req) => ctx.state.get(UPSTREAM_KEY)!(req),
        });
        await flushContext(ctx);
        return { status: ctx.state.get(CACHE_DECISION_KEY)!.status, body: await result.response.text() };
      }
      return { edgeCache, request };
    };
    return { a: make(), b: make() };
  }

  it('deletes every variant copy by key although the tag index belongs to another isolate', async () => {
    const { a, b } = isolates();
    for (const variant of ['control', 'b']) await a.request('https://x.test/pricing', variant);
    expect((await a.request('https://x.test/pricing', 'b')).status).toBe('HIT');
    // Isolate B has never seen these entries, so its tag index knows nothing about them.
    await b.request('https://x.test/', 'control');
    expect(await b.edgeCache.purgeTags(['path:/pricing'])).toBe(0);
    expect(await b.edgeCache.purgeUrls(['https://x.test/pricing'])).toBeGreaterThanOrEqual(2);
    expect((await a.request('https://x.test/pricing', 'control')).status).toBe('MISS');
    expect((await a.request('https://x.test/pricing', 'b')).status).toBe('MISS');
  });
});

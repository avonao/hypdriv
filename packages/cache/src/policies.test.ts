import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, makeManifest, makeRoute } from './__fixtures__/fakes';
import {
  cacheControlFor,
  effectiveTags,
  inferPolicies,
  MAX_PATH_TAG_LENGTH,
  matchPolicy,
  matchPolicyFor,
  nextPathnameToPattern,
  pathTag,
  resolvePolicies,
  routePatternSpecificity,
} from './policies';
import { bypassReason } from './stage';

const manifest = makeManifest([
  makeRoute({ pathname: '/', classification: 'static' }),
  makeRoute({ pathname: '/blog', classification: 'static' }),
  makeRoute({ pathname: '/blog/[slug]', classification: 'static' }),
  makeRoute({ pathname: '/docs/[...path]', classification: 'static' }),
  makeRoute({ pathname: '/shop/[[...slug]]', classification: 'static' }),
  makeRoute({ pathname: '/(marketing)/pricing', classification: 'static' }),
  makeRoute({ pathname: '/news/[id]', classification: 'isr', prerender: { revalidate: 30 } }),
  makeRoute({ pathname: '/feed', classification: 'isr', prerender: { revalidate: 3600 } }),
  makeRoute({ pathname: '/dashboard', classification: 'shell' }),
  makeRoute({ pathname: '/account', classification: 'dynamic' }),
  makeRoute({ pathname: '/api/users/[id]', kind: 'app-route', classification: 'route' }),
  makeRoute({ pathname: '/robots.txt', kind: 'static-file', classification: 'asset' }),
]);

describe('nextPathnameToPattern', () => {
  it('converts params, catch-alls and groups', () => {
    expect(nextPathnameToPattern('/')).toBe('/');
    expect(nextPathnameToPattern('/blog/[slug]')).toBe('/blog/:slug');
    expect(nextPathnameToPattern('/docs/[...path]')).toBe('/docs/:path*');
    expect(nextPathnameToPattern('/shop/[[...slug]]')).toEqual(['/shop', '/shop/:slug*']);
    expect(nextPathnameToPattern('/(marketing)/pricing')).toBe('/pricing');
    expect(nextPathnameToPattern('/@modal/(.)photo/[id]')).toBe('/(.)photo/:id');
    expect(nextPathnameToPattern('/a/[b-c]')).toBe('/a/:b_c');
  });
  it('ranks the broadest member of a pattern list', () => {
    expect(routePatternSpecificity(['/shop', '/shop/:slug*'])).toBeLessThan(
      routePatternSpecificity('/shop/:slug'),
    );
    expect(routePatternSpecificity(['/shop', '/shop/:slug*'])).toBe(routePatternSpecificity('/shop'));
    // Core semantics: more literal characters rank first, wildcards and params cost a little.
    expect(routePatternSpecificity('/blog')).toBeLessThan(routePatternSpecificity('/blog/:slug'));
  });
});

describe('inferPolicies / resolvePolicies', () => {
  it('infers static and ISR routes with inferredStatic durations, ordered by specificity', () => {
    const config = resolveConfig({
      cache: { edge: { inferredStatic: { ttl: 300, swr: 600, staleIfError: 900 } } },
    });
    const inferred = inferPolicies(config, manifest);
    const ids = inferred.map((p) => p.id);
    expect(ids).toContain('inferred:app:/blog/[slug]');
    expect(ids).not.toContain('inferred:app:/account');
    expect(ids).not.toContain('inferred:app:/dashboard');
    expect(ids).not.toContain('inferred:route:/api/users/[id]');
    expect(ids).not.toContain('inferred:static-file:/robots.txt');
    // patternSpecificity descending: longest literal prefix first, manifest order breaks ties, `/` last.
    expect(ids[0]).toBe('inferred:app:/(marketing)/pricing');
    expect(ids.indexOf('inferred:app:/blog/[slug]')).toBeLessThan(ids.indexOf('inferred:app:/blog'));
    expect(ids.indexOf('inferred:app:/blog/[slug]')).toBeLessThan(
      ids.indexOf('inferred:app:/docs/[...path]'),
    );
    expect(ids.indexOf('inferred:app:/blog')).toBeLessThan(ids.indexOf('inferred:app:/shop/[[...slug]]'));
    expect(ids.indexOf('inferred:app:/blog/[slug]')).toBeLessThan(
      ids.indexOf('inferred:app:/shop/[[...slug]]'),
    );
    expect(ids[ids.length - 1]).toBe('inferred:app:/');
    const blog = inferred.find((p) => p.id === 'inferred:app:/blog/[slug]')!;
    expect(blog).toMatchObject({
      ttl: 300,
      swr: 600,
      staleIfError: 900,
      source: 'inferred',
      tags: ['route:app:/blog/[slug]'],
      match: '/blog/:slug',
    });
    expect(blog.methods).toEqual(['GET', 'HEAD']);
  });

  it('gives every inferred policy the shared cache.edge.bypass (a gate cookie must skip the cache)', () => {
    const config = resolveConfig({
      cache: { edge: { bypass: { cookies: ['site_gate'], headers: ['X-Gate'] } } },
    });
    const inferred = inferPolicies(config, manifest);
    expect(inferred.length).toBeGreaterThan(0);
    for (const p of inferred) {
      expect(p.bypass.cookies).toEqual(['site_gate']);
      expect(p.bypass.headers).toEqual(['x-gate']);
    }
    const blog = inferred.find((p) => p.id === 'inferred:app:/blog')!;
    const withCookie = makeCtx(
      new Request('https://example.com/blog', { headers: { cookie: 'a=1; site_gate=signed' } }),
      { config, manifest },
    );
    expect(bypassReason(blog, withCookie)).toBe('cookie:site_gate');
    const anonymous = makeCtx('https://example.com/blog', { config, manifest });
    expect(bypassReason(blog, anonymous)).toBeNull();
  });

  it('caps ISR TTL at the route revalidate interval', () => {
    const config = resolveConfig({
      cache: { edge: { inferredStatic: { ttl: 300, swr: 600, staleIfError: 900 } } },
    });
    const inferred = inferPolicies(config, manifest);
    const news = inferred.find((p) => p.id === 'inferred:app:/news/[id]')!;
    const feed = inferred.find((p) => p.id === 'inferred:app:/feed')!;
    expect(news).toMatchObject({ ttl: 30, swr: 600, staleIfError: 900 });
    expect(feed).toMatchObject({ ttl: 300, swr: 600, staleIfError: 900 });
    const noRevalidate = inferPolicies(
      config,
      makeManifest([makeRoute({ pathname: '/x', classification: 'isr', prerender: { revalidate: false } })]),
    );
    expect(noRevalidate[0]?.ttl).toBe(300);
  });

  it('infers shell routes only when inferredShell is configured', () => {
    const off = resolveConfig({});
    expect(inferPolicies(off, manifest).some((p) => p.id === 'inferred:app:/dashboard')).toBe(false);
    const on = resolveConfig({ cache: { edge: { inferredShell: { ttl: 15, swr: 45 } } } });
    const shell = inferPolicies(on, manifest).find((p) => p.id === 'inferred:app:/dashboard');
    expect(shell).toMatchObject({ ttl: 15, swr: 45, staleIfError: 0 });
  });

  it('never infers a policy for fallback documents or documents the static layer serves', () => {
    const config = resolveConfig({});
    const flagged = {
      ...manifest,
      routes: manifest.routes.map((r) =>
        r.classification === 'static' ? { ...r, servedStatically: true } : r,
      ),
    };
    const staticIds = manifest.routes
      .filter((r) => r.classification === 'static')
      .map((r) => `inferred:${r.id}`);
    expect(staticIds.length).toBeGreaterThan(0);
    const ids = inferPolicies(config, flagged).map((p) => p.id);
    expect(ids.some((id) => staticIds.includes(id))).toBe(false);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('returns nothing when inference is off or the cache is disabled', () => {
    expect(inferPolicies(resolveConfig({ cache: { edge: { infer: false } } }), manifest)).toEqual([]);
    expect(resolvePolicies(resolveConfig({ cache: { edge: false } }), manifest)).toEqual([]);
  });

  it('places explicit policies first, in config order', () => {
    const config = resolveConfig({
      cache: {
        edge: {
          policies: [
            { id: 'blog', match: '/blog/**', ttl: '1h' },
            { match: '/api/**', ttl: 10 },
          ],
        },
      },
    });
    const all = resolvePolicies(config, manifest);
    expect(all.slice(0, 2).map((p) => [p.id, p.source])).toEqual([
      ['blog', 'explicit'],
      ['policy-1', 'explicit'],
    ]);
    expect(all[2]?.source).toBe('inferred');
  });
});

describe('matchPolicy', () => {
  const config = resolveConfig({
    cache: { edge: { policies: [{ id: 'blog-explicit', match: '/blog/:slug', ttl: 120, tags: ['blog'] }] } },
  });
  const policies = resolvePolicies(config, manifest);

  it('prefers explicit policies over inferred ones for the same path', () => {
    const ctx = makeCtx('https://x.test/blog/hello', { config, manifest });
    expect(ctx.route?.route.id).toBe('app:/blog/[slug]');
    expect(matchPolicy(policies, ctx)?.id).toBe('blog-explicit');
  });

  it('uses the route id fast path for inferred policies', () => {
    const ctx = makeCtx('https://x.test/shop', { config, manifest });
    expect(matchPolicy(policies, ctx)?.id).toBe('inferred:app:/shop/[[...slug]]');
    expect(matchPolicy(policies, makeCtx('https://x.test/shop/a/b', { config, manifest }))?.id).toBe(
      'inferred:app:/shop/[[...slug]]',
    );
    expect(matchPolicy(policies, makeCtx('https://x.test/pricing', { config, manifest }))?.id).toBe(
      'inferred:app:/(marketing)/pricing',
    );
  });

  it('falls back to pattern matching without a route and returns null for dynamic routes', () => {
    expect(matchPolicyFor(policies, new URL('https://x.test/docs/a/b'), null)?.id).toBe(
      'inferred:app:/docs/[...path]',
    );
    expect(matchPolicyFor(policies, new URL('https://x.test/shop'), null)?.id).toBe(
      'inferred:app:/shop/[[...slug]]',
    );
    expect(matchPolicy(policies, makeCtx('https://x.test/account', { config, manifest }))).toBeNull();
    expect(matchPolicy(policies, makeCtx('https://x.test/nope', { config, manifest }))).toBeNull();
  });

  it('honours a precomputed cachePolicyId and basePath', () => {
    const route = makeRoute({
      pathname: '/account',
      classification: 'dynamic',
      cachePolicyId: 'blog-explicit',
    });
    expect(matchPolicyFor(policies, new URL('https://x.test/account'), { route, params: {} })?.id).toBe(
      'blog-explicit',
    );
    const withBase = makeManifest(manifest.routes, { basePath: '/app' });
    const ctx = makeCtx('https://x.test/app/blog/x', { config, manifest: withBase });
    expect(matchPolicy(policies, ctx)?.id).toBe('blog-explicit');
  });
});

describe('cacheControlFor / effectiveTags', () => {
  it('renders the downstream Cache-Control', () => {
    expect(cacheControlFor({ ttl: 300, swr: 600, staleIfError: 900 })).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=600, stale-if-error=900',
    );
    expect(cacheControlFor({ ttl: 60, swr: 0, staleIfError: 0 })).toBe('public, max-age=0, s-maxage=60');
  });
  it('adds route and build tags without duplicates', () => {
    const config = resolveConfig({
      cache: { edge: { policies: [{ match: '/**', ttl: 1, tags: ['a', 'route:app:/x'] }] } },
    });
    const policy = config.cache.edge!.policies[0]!;
    const route = makeRoute({ pathname: '/x' });
    expect(effectiveTags(policy, { route, params: {} }, 'b9')).toEqual(['a', 'route:app:/x', 'build:b9']);
    expect(effectiveTags(policy, null, 'b9')).toEqual(['a', 'route:app:/x', 'build:b9']);
  });
  it('tags every variant of a page with its normalised path', () => {
    const config = resolveConfig({ cache: { edge: { policies: [{ match: '/**', ttl: 1 }] } } });
    const policy = config.cache.edge!.policies[0]!;
    expect(effectiveTags(policy, null, 'b9', '/blog/a/')).toEqual(['path:/blog/a', 'build:b9']);
    expect(pathTag('/')).toBe('path:/');
    expect(pathTag('')).toBe('path:/');
    expect(pathTag('/blog/a')).toBe(pathTag('/blog/a/'));
    expect(pathTag(`/${'x'.repeat(MAX_PATH_TAG_LENGTH)}`)).toBeNull();
    expect(effectiveTags(policy, null, 'b9', `/${'x'.repeat(MAX_PATH_TAG_LENGTH)}`)).toEqual(['build:b9']);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createContext,
  createRouteMatcher,
  HEADER,
  type HypDrivConfig,
  type HypManifest,
  loadConfig,
  parseServerTiming,
  type ResolvedConfig,
  runPipeline,
  stateKey,
} from '@hypdriv/core';
import { CSP_DECISION_KEY, CSP_MODE_KEY, cspStage, NONCE_KEY } from '@hypdriv/security';
import { runStage } from '@hypdriv/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogger, makeManifest, makeRoute } from './__fixtures__/fakes';
import {
  CDN_DECISION_KEY,
  type CdnPlan,
  cdnCacheControl,
  cdnExpressibility,
  cdnVerdict,
  vercelCdnStage,
  withVercelCdn,
} from './cdn';
import { __resetWarnings } from './util';

const manifest = makeManifest([
  makeRoute({ pathname: '/products/[id]', classification: 'dynamic' }),
  makeRoute({ pathname: '/about', classification: 'static' }),
  makeRoute({ pathname: '/news/[id]', classification: 'isr', prerender: { revalidate: 30 } }),
]);

const PRODUCTS = {
  id: 'products',
  match: '/products/:id',
  ttl: '5m',
  swr: '1h',
  staleIfError: '1d',
  tags: ['products'],
};

function configWith(input: HypDrivConfig = {}): ResolvedConfig {
  return loadConfig({ cache: { edge: { policies: [PRODUCTS] } }, ...input });
}

function ctxFor(
  url: string,
  options: { config?: ResolvedConfig; manifest?: HypManifest; headers?: HeadersInit; method?: string } = {},
) {
  const config = options.config ?? configWith();
  const m = options.manifest ?? manifest;
  const request = new Request(url, { method: options.method ?? 'GET', headers: options.headers });
  const log = captureLogger();
  const ctx = createContext({
    request,
    config,
    manifest: m,
    route: createRouteMatcher(m).match(new URL(url).pathname),
    runner: 'proxy',
    log,
  });
  return { ctx, log };
}

async function run(
  url: string,
  options: Parameters<typeof ctxFor>[1] & {
    response?: () => Response;
    stageConfig?: ResolvedConfig;
    downstream?: boolean;
  } = {},
) {
  const { ctx, log } = ctxFor(url, options);
  const stage = vercelCdnStage(
    options.stageConfig ?? ctx.config,
    options.downstream !== undefined ? { downstream: options.downstream } : {},
  )!;
  const result = await runStage(stage, ctx, options.response ?? (() => new Response('ok')));
  return { ...result, ctx, log, decision: ctx.state.get(CDN_DECISION_KEY) };
}

beforeEach(() => __resetWarnings());

describe('vercelCdnStage', () => {
  it('is the edge-cache replacement, runs on RSC requests, and is null when disabled', () => {
    const stage = vercelCdnStage(configWith())!;
    expect(stage.name).toBe('edge-cache');
    expect(stage.runOnRsc).toBe(true);
    expect(vercelCdnStage(configWith({ vercel: { cdn: false } }))).toBeNull();
    expect(vercelCdnStage(loadConfig({ cache: { edge: false } }))).toBeNull();
  });

  it('expresses a matched policy as Vercel CDN headers with tags', async () => {
    const { response, decision, timings } = await run('https://shop.example.com/products/42');
    expect(response.headers.get('vercel-cdn-cache-control')).toBe(
      's-maxage=300, stale-while-revalidate=3600, stale-if-error=86400',
    );
    expect(response.headers.get('cdn-cache-control')).toBeNull();
    expect(response.headers.get('vercel-cache-tag')).toBe(
      'hyp:path:/products/42,hyp:route:app:/products/[id],products,route:app:/products/[id],build:build-1',
    );
    expect(response.headers.get('x-hypdriv-cache')).toBe('CDN');
    expect(decision).toMatchObject({
      status: 'CDN',
      reason: 'policy',
      cacheControl: expect.stringContaining('s-maxage=300'),
    });
    expect(decision?.policy?.id).toBe('products');
    expect(timings.filter((t) => t.name === 'cache').map((t) => t.desc)).toEqual(['CDN']);
  });

  it('adds CDN-Cache-Control for downstream CDNs (option or config)', async () => {
    const viaOption = await run('https://shop.example.com/products/1', { downstream: true });
    expect(viaOption.response.headers.get('cdn-cache-control')).toBe(
      viaOption.response.headers.get('vercel-cdn-cache-control'),
    );
    const viaConfig = await run('https://shop.example.com/products/1', {
      config: configWith({ vercel: { cdn: { downstream: true } } }),
    });
    expect(viaConfig.response.headers.get('cdn-cache-control')).toMatch(/^s-maxage=300/);
  });

  it('maps vary dimensions and bypass headers to Vary request headers', async () => {
    const config = configWith({
      cache: {
        edge: {
          policies: [
            {
              id: 'catalog',
              match: '/catalog/**',
              ttl: 60,
              vary: {
                headers: ['X-Api-Version'],
                geo: ['country', 'region', 'colo'],
                language: true,
                device: true,
              },
              bypass: { headers: ['x-preview', 'authorization'] },
            },
          ],
        },
      },
      i18n: {
        locales: ['en-US', 'de-DE'],
        defaultLocale: 'en-US',
        strategy: 'header',
        geoMap: { DE: 'de-DE' },
      },
    });
    const { response } = await run('https://shop.example.com/catalog/shoes', {
      config,
      response: () => new Response('ok', { headers: { vary: 'RSC' } }),
    });
    expect(response.headers.get('vary')).toBe(
      'RSC, x-api-version, x-preview, X-Vercel-IP-Country, X-Vercel-IP-Country-Region, Accept-Language, Sec-CH-UA-Mobile, User-Agent',
    );
  });

  it('reports pages whose policy has no route-header form as BYPASS (Route Handlers stay CDN)', async () => {
    const geoManifest = makeManifest([
      makeRoute({ pathname: '/geo', classification: 'dynamic' }),
      makeRoute({ pathname: '/api/geo', kind: 'app-route', classification: 'route' }),
    ]);
    const config = configWith({
      cache: {
        edge: {
          policies: [
            {
              id: 'geo',
              match: ['/geo', '/api/geo'],
              ttl: '10m',
              vary: { geo: ['country'] },
              respectOrigin: false,
            },
          ],
        },
      },
    });
    const page = await run('https://shop.example.com/geo', { config, manifest: geoManifest });
    expect(page.decision).toMatchObject({ status: 'BYPASS', reason: 'route-header:vary' });
    expect(page.response.headers.get('x-hypdriv-cache')).toBe('BYPASS');
    expect(page.response.headers.get('x-hypdriv-cache-reason')).toBe('route-header:vary');
    expect(page.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(page.log.lines.filter((l) => l.message.includes('no route-header form'))).toHaveLength(1);
    const handler = await run('https://shop.example.com/api/geo', { config, manifest: geoManifest });
    expect(handler.decision).toMatchObject({ status: 'CDN' });
    expect(handler.response.headers.get('x-hypdriv-cache-reason')).toBeNull();
    expect(handler.response.headers.get('vary')).toContain('X-Vercel-IP-Country');
    // Expressible page policies keep their CDN decision (the route headers carry them).
    const products = await run('https://shop.example.com/products/9');
    expect(products.decision).toMatchObject({ status: 'CDN' });
  });

  it('leaves non-GET requests and unmatched paths dynamic', async () => {
    const post = await run('https://shop.example.com/products/1', { method: 'POST' });
    expect(post.decision).toEqual({ status: 'DYNAMIC', reason: 'method:POST' });
    expect(post.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    const other = await run('https://shop.example.com/cart');
    expect(other.decision).toEqual({ status: 'DYNAMIC', reason: 'no-policy' });
    expect(other.timings.find((t) => t.name === 'cache')?.desc).toBe('DYNAMIC');
  });

  it('caches HEAD requests like GET', async () => {
    const { decision } = await run('https://shop.example.com/products/1', { method: 'HEAD' });
    expect(decision?.status).toBe('CDN');
  });

  it('bypasses Authorization, bypass headers and bypass query parameters, but not request no-cache', async () => {
    const config = configWith({
      cache: {
        edge: { policies: [{ ...PRODUCTS, bypass: { headers: ['x-preview'], query: ['draft'] } }] },
      },
    });
    const auth = await run('https://shop.example.com/products/1', {
      config,
      headers: { authorization: 'Bearer x' },
    });
    expect(auth.decision).toMatchObject({ status: 'BYPASS', reason: 'authorization' });
    expect(auth.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(auth.timings.find((t) => t.name === 'cache')?.desc).toBe('BYPASS');
    const preview = await run('https://shop.example.com/products/1', {
      config,
      headers: { 'x-preview': '1' },
    });
    expect(preview.decision).toMatchObject({ status: 'BYPASS', reason: 'header:x-preview' });
    const draft = await run('https://shop.example.com/products/1?draft=1', { config });
    expect(draft.decision).toMatchObject({ status: 'BYPASS', reason: 'query:draft' });
    const noCache = await run('https://shop.example.com/products/1', {
      config,
      headers: { 'cache-control': 'no-cache' },
    });
    expect(noCache.decision?.status).toBe('CDN');
    expect(noCache.response.headers.get('vary')).toBe('x-preview');
  });

  it('refuses policies the CDN cannot express and warns once per policy', async () => {
    const cases: Array<[Record<string, unknown>, string, HypDrivConfig?]> = [
      [{ vary: { cookies: ['session'] } }, 'vary:cookies'],
      [{ vary: { flags: ['beta'] } }, 'vary:flags'],
      [{ bypass: { cookies: ['session'] } }, 'bypass:cookies'],
      [{ bypass: { when: () => false } }, 'bypass:when'],
      [{ vary: { headers: ['Cookie'] } }, 'vary:cookie'],
      [
        { vary: { language: true } },
        'vary:language-cookie',
        { i18n: { locales: ['en'], defaultLocale: 'en', strategy: 'cookie' } },
      ],
    ];
    for (const [extra, reason, more] of cases) {
      __resetWarnings();
      const config = configWith({
        cache: { edge: { policies: [{ ...PRODUCTS, ...extra }] } },
        ...(more ?? {}),
      });
      const first = await run('https://shop.example.com/products/1', { config });
      expect(first.decision).toMatchObject({ status: 'BYPASS', reason });
      expect(first.response.headers.get('vercel-cdn-cache-control')).toBeNull();
      expect(first.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
      const second = await run('https://shop.example.com/products/2', { config });
      expect(second.log.lines.filter((l) => l.level === 'warn')).toHaveLength(0);
    }
  });

  it('drops the CDN headers when the response sets a cookie', async () => {
    const { response, decision } = await run('https://shop.example.com/products/1', {
      response: () => new Response('ok', { headers: { 'set-cookie': 'sid=1; Path=/' } }),
    });
    expect(response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(response.headers.get('vercel-cache-tag')).toBeNull();
    expect(response.headers.get('x-hypdriv-cache')).toBe('BYPASS');
    expect(decision).toMatchObject({ status: 'BYPASS', reason: 'uncacheable:set-cookie' });
  });

  it('drops the CDN headers when an earlier stage queued a cookie or the flags cookie is pending', async () => {
    const queued = ctxFor('https://shop.example.com/products/1');
    queued.ctx.responseHeaders.append('set-cookie', 'clearance=1');
    const a = await runStage(vercelCdnStage(queued.ctx.config)!, queued.ctx);
    expect(a.response.headers.get('vercel-cdn-cache-control')).toBeNull();

    const flags = ctxFor('https://shop.example.com/products/1');
    flags.ctx.state.set(stateKey<boolean>('flags.needsCookie'), true);
    const b = await runStage(vercelCdnStage(flags.ctx.config)!, flags.ctx);
    expect(b.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(flags.ctx.state.get(CDN_DECISION_KEY)?.reason).toBe('uncacheable:set-cookie');
  });

  it('drops the CDN headers when the flags stage may set the experiment cookie', async () => {
    const experiment = ctxFor('https://shop.example.com/products/1');
    experiment.ctx.state.set(stateKey<boolean>('flags.experimentCookie'), true);
    const { response } = await runStage(vercelCdnStage(experiment.ctx.config)!, experiment.ctx);
    expect(response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(experiment.ctx.state.get(CDN_DECISION_KEY)?.reason).toBe('uncacheable:set-cookie');
  });

  it('applies the negative TTL to 404 and 410 responses', async () => {
    const notFound = await run('https://shop.example.com/products/404', {
      response: () => new Response('no', { status: 404 }),
    });
    expect(notFound.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=60');
    expect(notFound.decision).toMatchObject({
      status: 'CDN',
      reason: 'negative',
      cacheControl: 's-maxage=60',
    });
    const gone = await run('https://shop.example.com/products/1', {
      config: configWith({ cache: { edge: { policies: [PRODUCTS], negativeTtl: 0 } } }),
      response: () => new Response('gone', { status: 410 }),
    });
    expect(gone.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(gone.decision?.reason).toBe('uncacheable:negative-disabled');
  });

  it('never marks errors or statuses outside the policy as cacheable', async () => {
    const error = await run('https://shop.example.com/products/1', {
      response: () => new Response('x', { status: 500 }),
    });
    expect(error.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(error.decision?.reason).toBe('uncacheable:status:500');
    const redirect = await run('https://shop.example.com/products/1', {
      response: () => new Response(null, { status: 302, headers: { location: '/x' } }),
    });
    expect(redirect.decision?.reason).toBe('uncacheable:status:302');
  });

  it('respects the origin Cache-Control', async () => {
    const privateResponse = await run('https://shop.example.com/products/1', {
      response: () => new Response('x', { headers: { 'cache-control': 'private, no-store' } }),
    });
    expect(privateResponse.response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(privateResponse.decision?.reason).toBe('uncacheable:origin:no-store');
    const shorter = await run('https://shop.example.com/products/1', {
      response: () =>
        new Response('x', { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=10' } }),
    });
    expect(shorter.response.headers.get('vercel-cdn-cache-control')).toBe(
      's-maxage=30, stale-while-revalidate=10, stale-if-error=86400',
    );
    const strict = await run('https://shop.example.com/products/1', {
      response: () => new Response('x', { headers: { 'cache-control': 'max-age=600, must-revalidate' } }),
    });
    expect(strict.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=300');
    const ignored = await run('https://shop.example.com/products/1', {
      config: configWith({ cache: { edge: { policies: [{ ...PRODUCTS, respectOrigin: false }] } } }),
      response: () => new Response('x', { headers: { 'cache-control': 'private' } }),
    });
    expect(ignored.response.headers.get('vercel-cdn-cache-control')).toMatch(/^s-maxage=300/);
  });

  it('defers to an origin that set its own CDN headers and keeps its tags', async () => {
    const own = await run('https://shop.example.com/products/1', {
      response: () => new Response('x', { headers: { 'vercel-cdn-cache-control': 's-maxage=5' } }),
    });
    expect(own.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=5');
    expect(own.decision?.reason).toBe('uncacheable:origin:cdn-cache-control');
    const tagged = await run('https://shop.example.com/products/1', {
      response: () => new Response('x', { headers: { 'vercel-cache-tag': 'sku-1,products' } }),
    });
    expect(tagged.response.headers.get('vercel-cache-tag')?.split(',').slice(0, 3)).toEqual([
      'sku-1',
      'products',
      'hyp:path:/products/1',
    ]);
    expect(tagged.decision?.tags?.[0]).toBe('sku-1');
  });

  it('skips RSC requests when the policy excludes them', async () => {
    const config = configWith({ cache: { edge: { policies: [{ ...PRODUCTS, includeRsc: false }] } } });
    const rsc = await run('https://shop.example.com/products/1', { config, headers: { rsc: '1' } });
    expect(rsc.decision).toMatchObject({ status: 'BYPASS', reason: 'rsc' });
    const included = await run('https://shop.example.com/products/1', { headers: { rsc: '1' } });
    expect(included.decision?.status).toBe('CDN');
  });

  it('uses policies inferred from the manifest for static and ISR routes', async () => {
    const about = await run('https://shop.example.com/about');
    expect(about.response.headers.get('vercel-cdn-cache-control')).toBe(
      's-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
    );
    expect(about.decision?.policy?.id).toBe('inferred:app:/about');
    const news = await run('https://shop.example.com/news/7');
    expect(news.response.headers.get('vercel-cdn-cache-control')).toMatch(/^s-maxage=30,/);
  });

  it('clamps lifetimes to what Vercel accepts and caps tags at 128', async () => {
    const tags = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const config = configWith({
      cache: { edge: { policies: [{ ...PRODUCTS, ttl: '800d', swr: '1000d', tags }] } },
    });
    const { response } = await run('https://shop.example.com/products/1', { config });
    expect(response.headers.get('vercel-cdn-cache-control')).toBe(
      's-maxage=31536000, stale-while-revalidate=31536000, stale-if-error=86400',
    );
    expect(response.headers.get('vercel-cache-tag')!.split(',')).toHaveLength(128);
  });

  it('records the cache marker for Server-Timing consumers', async () => {
    const { ctx } = await run('https://shop.example.com/products/1');
    expect(parseServerTiming(ctx.timings.toHeader('compact')).find((e) => e.name === 'cache')?.desc).toBe(
      'CDN',
    );
  });
});

describe('vercelCdnStage with a per-request CSP nonce', () => {
  const dynamicPages = makeManifest([
    makeRoute({ pathname: '/products/[id]', classification: 'dynamic' }),
    makeRoute({ pathname: '/api/items', kind: 'app-route', classification: 'route' }),
    makeRoute({ pathname: '/docs', classification: 'static' }),
  ]);
  const forced = {
    id: 'forced',
    match: ['/products/:id', '/api/items', '/docs'],
    ttl: '5m',
    respectOrigin: false,
  };
  const html = (headers: Record<string, string> = {}) =>
    new Response('<html><script>1</script></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    });

  async function pipeline(
    url: string,
    options: {
      policy?: Record<string, unknown>;
      csp?: HypDrivConfig['security'];
      headers?: HeadersInit;
      responseOwner?: boolean;
      next?: () => Response;
    } = {},
  ) {
    const config = loadConfig({
      security: options.csp ?? {},
      cache: { edge: { policies: [options.policy ?? PRODUCTS] } },
    } as HypDrivConfig);
    const { ctx, log } = ctxFor(url, { config, manifest: dynamicPages, headers: options.headers });
    let forwarded: Request | null = null;
    const { response } = await runPipeline({
      stages: [
        cspStage(config),
        vercelCdnStage(config, options.responseOwner ? { responseOwner: true } : {})!,
      ],
      ctx,
      next: async (request) => {
        forwarded = request;
        return (options.next ?? html)();
      },
    });
    return { response, ctx, log, forwarded: forwarded as Request | null };
  }

  it('serves a force-cached page with the unsafe-inline fallback instead of a nonce the CDN would reuse', async () => {
    const { response, ctx, log, forwarded } = await pipeline('https://shop.example.com/products/7', {
      policy: forced,
    });
    expect(response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=300');
    expect(ctx.state.get(CDN_DECISION_KEY)?.status).toBe('CDN');
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('unsafe-inline-fallback');
    expect(ctx.state.get(NONCE_KEY)).toBeUndefined();
    expect(response.headers.get('x-hypdriv-csp')).toBe('unsafe-inline-fallback');
    expect(response.headers.get('content-security-policy')).not.toContain('nonce-');
    expect(forwarded?.headers.get(HEADER.nonce)).toBeNull();
    expect(forwarded?.headers.get('content-security-policy')).toBeNull();
    expect(log.lines.filter((l) => l.message.includes('per-request CSP nonce'))).toHaveLength(1);
  });

  it('keeps the nonce on a policy that respects the origin, and keeps the page out of the CDN', async () => {
    const { response, ctx, forwarded } = await pipeline('https://shop.example.com/products/7');
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('nonce');
    expect(forwarded?.headers.get(HEADER.nonce)).toBeTruthy();
    expect(response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(response.headers.get('vercel-cache-tag')).toBeNull();
    expect(response.headers.get('x-hypdriv-cache')).toBe('BYPASS');
    expect(ctx.state.get(CDN_DECISION_KEY)).toMatchObject({ status: 'BYPASS', reason: 'uncacheable:nonce' });
    expect(response.headers.get('content-security-policy')).toContain('nonce-');
  });

  it('replaces shared-cache headers on a nonce document produced by the function', async () => {
    const { response, log } = await pipeline('https://shop.example.com/products/7', {
      responseOwner: true,
      next: () =>
        html({ 'cache-control': 'public, s-maxage=600', 'vercel-cdn-cache-control': 'max-age=600' }),
    });
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(response.headers.get('cdn-cache-control')).toBeNull();
    expect(log.lines.filter((l) => l.message.includes('replaced with "private, no-cache"'))).toHaveLength(1);
  });

  it("leaves a nonce document's private caching alone", async () => {
    const { response, log } = await pipeline('https://shop.example.com/products/7', {
      responseOwner: true,
      next: () => html({ 'cache-control': 'private, max-age=0, must-revalidate' }),
    });
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(log.lines.some((l) => l.message.includes('replaced with'))).toBe(false);
  });

  it('does not touch Route Handlers, client navigation payloads or non-HTML responses', async () => {
    const handler = await pipeline('https://shop.example.com/api/items', {
      policy: forced,
      next: () => Response.json({ ok: true }),
    });
    expect(handler.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=300');
    expect(handler.ctx.state.get(CSP_DECISION_KEY)?.mode).toBe('nonce');

    const rsc = await pipeline('https://shop.example.com/products/7', {
      policy: forced,
      headers: { rsc: '1' },
      next: () => new Response('0:[]', { headers: { 'content-type': 'text/x-component' } }),
    });
    expect(rsc.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=300');
    expect(rsc.ctx.state.get(CSP_DECISION_KEY)?.mode).toBe('nonce');
  });

  it('does nothing for hash CSP, disabled CSP and routes the policy does not cover', async () => {
    const hash = await pipeline('https://shop.example.com/docs', { policy: forced });
    expect(hash.ctx.state.get(CSP_MODE_KEY)).not.toBe('nonce');
    expect(hash.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=300');

    const off = await pipeline('https://shop.example.com/products/7', {
      policy: forced,
      csp: { csp: false },
    });
    expect(off.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=300');
    expect(off.response.headers.get('content-security-policy')).toBeNull();

    const unmatched = await pipeline('https://shop.example.com/other');
    expect(unmatched.ctx.state.get(CDN_DECISION_KEY)?.reason).toBe('no-policy');
  });
});

describe('cdnCacheControl / cdnVerdict / cdnExpressibility', () => {
  it('builds and clamps the directive', () => {
    expect(cdnCacheControl({ ttl: 0 })).toBe('s-maxage=1');
    expect(cdnCacheControl({ ttl: 10.9, swr: 0, staleIfError: 5 })).toBe('s-maxage=10, stale-if-error=5');
    expect(cdnCacheControl({ ttl: Number.NaN })).toBe('s-maxage=1');
  });

  const plan: CdnPlan = {
    ttl: 100,
    swr: 10,
    staleIfError: 0,
    negativeTtl: 5,
    statuses: [200, 404],
    respectOrigin: true,
    tags: [],
    vary: [],
    downstream: false,
  };

  it('judges responses', () => {
    expect(cdnVerdict(plan, new Response('x'))).toEqual({
      ok: true,
      cacheControl: 's-maxage=100, stale-while-revalidate=10',
      negative: false,
    });
    expect(cdnVerdict(plan, new Response('x', { headers: { vary: 'Accept, *' } }))).toEqual({
      ok: false,
      reason: 'vary:*',
    });
    expect(cdnVerdict(plan, new Response('x', { headers: { vary: 'Cookie' } }))).toEqual({
      ok: false,
      reason: 'vary:cookie',
    });
    expect(cdnVerdict(plan, new Response('x', { headers: { 'cache-control': 'max-age=0' } }))).toEqual({
      ok: false,
      reason: 'origin:max-age=0',
    });
    expect(cdnVerdict(plan, new Response('x', { headers: { 'cache-control': 'no-cache' } }))).toMatchObject({
      ok: false,
    });
    expect(cdnVerdict(plan, new Response('x', { status: 410 }))).toEqual({ ok: false, reason: 'status:410' });
    expect(cdnVerdict(plan, new Response('x'), { pendingSetCookie: true })).toEqual({
      ok: false,
      reason: 'set-cookie',
    });
  });

  it('accepts expressible policies', () => {
    const config = configWith();
    expect(cdnExpressibility(config.cache.edge!.policies[0]!, config)).toEqual({ ok: true, vary: [] });
  });
});

describe('withVercelCdn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reads .hypdriv/manifest.json from the function directory by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-vercel-manifest-'));
    mkdirSync(join(dir, '.hypdriv'));
    writeFileSync(join(dir, '.hypdriv', 'manifest.json'), JSON.stringify(manifest));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const handler = withVercelCdn(configWith(), async () => Response.json({ ok: true }));
    const response = await handler(new Request('https://shop.example.com/products/9'), undefined);
    expect(response.headers.get('vercel-cache-tag')).toContain(`build:${manifest.buildId}`);
    expect(response.headers.get('vercel-cache-tag')).toContain('hyp:route:app:/products/[id]');
  });

  it('falls back to the Vercel deployment id as build id without a manifest file', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'hypdriv-vercel-empty-')));
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_abc');
    const handler = withVercelCdn(configWith(), async () => Response.json({ ok: true }));
    const response = await handler(new Request('https://shop.example.com/products/9'), undefined);
    expect(response.headers.get('vercel-cache-tag')).toContain('build:dpl_abc');
  });

  it('adds the CDN headers to a Route Handler response', async () => {
    const config = configWith();
    const handler = withVercelCdn(
      config,
      async (_request: Request, context: { params: Promise<{ id: string }> }) => {
        const { id } = await context.params;
        return Response.json({ id }, { headers: { vary: 'Accept' } });
      },
      { manifest, downstream: true },
    );
    const response = await handler(new Request('https://shop.example.com/products/9'), {
      params: Promise.resolve({ id: '9' }),
    });
    expect(await response.json()).toEqual({ id: '9' });
    expect(response.headers.get('vercel-cdn-cache-control')).toBe(
      's-maxage=300, stale-while-revalidate=3600, stale-if-error=86400',
    );
    expect(response.headers.get('cdn-cache-control')).toBe(response.headers.get('vercel-cdn-cache-control'));
    expect(response.headers.get('vercel-cache-tag')).toContain('hyp:route:app:/products/[id]');
    expect(response.headers.get('vary')).toBe('Accept');
  });

  it('leaves uncacheable and unmatched responses alone', async () => {
    const config = configWith();
    const cookie = withVercelCdn(config, () => new Response('x', { headers: { 'set-cookie': 'a=1' } }));
    expect(
      (await cookie(new Request('https://shop.example.com/products/1'), undefined)).headers.get(
        'vercel-cdn-cache-control',
      ),
    ).toBeNull();
    const unmatched = withVercelCdn(config, () => new Response('x'));
    expect(
      (await unmatched(new Request('https://shop.example.com/cart'), undefined)).headers.get(
        'vercel-cdn-cache-control',
      ),
    ).toBeNull();
    const authorized = withVercelCdn(config, () => new Response('x'));
    const res = await authorized(
      new Request('https://shop.example.com/products/1', { headers: { authorization: 'Bearer t' } }),
      undefined,
    );
    expect(res.headers.get('vercel-cdn-cache-control')).toBeNull();
  });

  it('passes through when the CDN integration is disabled', async () => {
    const original = new Response('x');
    const handler = withVercelCdn(configWith({ vercel: { cdn: false } }), () => original);
    expect(await handler(new Request('https://shop.example.com/products/1'), undefined)).toBe(original);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve';
import { createRouteMatcher, routePatternToRegex } from '../manifest/matcher';
import { emptyManifest, type HypRoute } from '../manifest/types';
import { createContext, flushContext, stateKey } from './context';
import { runPipeline } from './run';
import { DEFAULT_STAGE_ORDER, defineStage, orderStages } from './stage';
import { parseServerTiming, Timings } from './timing';

const config = resolveConfig({});

function route(partial: Partial<HypRoute> & Pick<HypRoute, 'pathname' | 'kind'>): HypRoute {
  const dynamic = partial.dynamic ?? /\[/.test(partial.pathname);
  return {
    id: `${partial.kind}:${partial.pathname}`,
    regex: routePatternToRegex(partial.pathname),
    classification: 'dynamic',
    runtime: 'nodejs',
    dynamic,
    assets: { js: [], css: [], fonts: [] },
    ...partial,
  };
}

describe('runPipeline', () => {
  it('runs pre in order, post in reverse, merges response headers', async () => {
    const order: string[] = [];
    const stages = [
      defineStage({
        name: 'a',
        pre(ctx) {
          order.push('a.pre');
          ctx.requestHeaders.set('x-from-a', '1');
          ctx.responseHeaders.set('x-res-a', '1');
        },
        post(_ctx, res) {
          order.push('a.post');
          return res;
        },
      }),
      defineStage({
        name: 'b',
        pre() {
          order.push('b.pre');
        },
        post(_ctx, res) {
          order.push('b.post');
          return res;
        },
      }),
    ];
    const ctx = createContext({ request: new Request('https://x.test/page'), config, runner: 'test' });
    let forwarded: Request | undefined;
    const { response, shortCircuitedBy, ran } = await runPipeline({
      stages,
      ctx,
      next: async (req) => {
        forwarded = req;
        order.push('next');
        return new Response('ok', { headers: { 'x-next': '1' } });
      },
    });
    expect(order).toEqual(['a.pre', 'b.pre', 'next', 'b.post', 'a.post']);
    expect(forwarded?.headers.get('x-from-a')).toBe('1');
    expect(response.headers.get('x-res-a')).toBe('1');
    expect(response.headers.get('x-next')).toBe('1');
    expect(shortCircuitedBy).toBeNull();
    expect(ran).toEqual(['a', 'b']);
    expect(ctx.timings.list().map((t) => t.name)).toEqual(['a', 'b', 'next', 'b.post', 'a.post']);
  });

  it('short-circuits when a stage returns a response and still runs post stages', async () => {
    let nextCalled = false;
    const stages = [
      defineStage({ name: 'guard', pre: () => new Response('blocked', { status: 403 }) }),
      defineStage({
        name: 'never',
        pre() {
          throw new Error('should not run');
        },
      }),
      defineStage({
        name: 'headers',
        post(_ctx, res) {
          const h = new Headers(res.headers);
          h.set('x-post', '1');
          return new Response(res.body, { status: res.status, headers: h });
        },
      }),
    ];
    const ctx = createContext({ request: new Request('https://x.test/'), config });
    const { response, shortCircuitedBy } = await runPipeline({
      stages: orderStages(stages, { order: ['guard', 'never', 'headers'] }),
      ctx,
      next: async () => {
        nextCalled = true;
        return new Response('x');
      },
    });
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-post')).toBe('1');
    expect(shortCircuitedBy).toBe('guard');
  });

  it('skips edgeOnly stages for the proxy runner and internal paths by default', async () => {
    const seen: string[] = [];
    const stages = [
      defineStage({ name: 'edge', edgeOnly: true, pre: () => void seen.push('edge') }),
      defineStage({ name: 'plain', pre: () => void seen.push('plain') }),
      defineStage({ name: 'internal', runOnInternal: true, pre: () => void seen.push('internal') }),
    ];
    const ctx = createContext({
      request: new Request('https://x.test/_next/static/x.js'),
      config,
      runner: 'proxy',
    });
    await runPipeline({ stages, ctx, next: async () => new Response(''), skipEdgeOnly: true });
    expect(seen).toEqual(['internal']);
  });

  it('recovers from stage errors with onStageError', async () => {
    const stages = [
      defineStage({
        name: 'boom',
        pre() {
          throw new Error('boom');
        },
      }),
    ];
    const ctx = createContext({ request: new Request('https://x.test/'), config });
    const { response } = await runPipeline({
      stages,
      ctx,
      next: async () => new Response('ok'),
      onStageError: (err) => new Response(err.message, { status: 500 }),
    });
    expect(response.status).toBe(500);
    await expect(
      runPipeline({
        stages,
        ctx: createContext({ request: new Request('https://x.test/'), config }),
        next: async () => new Response('ok'),
      }),
    ).rejects.toThrow('boom');
  });

  it('tracks background work with the default waitUntil', async () => {
    const ctx = createContext({ request: new Request('https://x.test/'), config });
    let done = false;
    ctx.waitUntil(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          done = true;
          resolve();
        }, 5),
      ),
    );
    await flushContext(ctx);
    expect(done).toBe(true);
  });

  it('typed state keys', () => {
    const ctx = createContext({ request: new Request('https://x.test/'), config });
    const K = stateKey<number>('n');
    ctx.state.set(K, 3);
    expect(ctx.state.get(K)).toBe(3);
    expect(ctx.state.entries()).toEqual([['n', 3]]);
  });
});

describe('orderStages', () => {
  it('orders by default list, drops disabled and duplicates', () => {
    const stages = ['observe', 'csp', 'custom', 'request-id', 'csp'].map((name) => defineStage({ name }));
    expect(orderStages(stages, { disable: ['observe'] }).map((s) => s.name)).toEqual([
      'request-id',
      'csp',
      'custom',
    ]);
    expect(DEFAULT_STAGE_ORDER[0]).toBe('request-id');
  });
  it('rejects invalid names', () => {
    expect(() => defineStage({ name: 'Bad Name' })).toThrow();
  });
});

describe('Timings', () => {
  it('renders compact and verbose Server-Timing', () => {
    const t = new Timings();
    const end = t.start('cache');
    end('HIT');
    t.record('shield', 0.5);
    t.mark('csp', 'nonce');
    const compact = parseServerTiming(t.toHeader('compact')).map((e) => e.name);
    expect(compact).toEqual(['cache', 'csp', 'total']);
    const verbose = parseServerTiming(t.toHeader('verbose'));
    expect(verbose.map((e) => e.name)).toEqual(['cache', 'shield', 'csp', 'total']);
    expect(verbose[0]?.desc).toBe('HIT');
    expect(t.toHeader('off')).toBe('');
  });
});

describe('route matcher', () => {
  const manifest = emptyManifest({
    routes: [
      route({ pathname: '/', kind: 'app-page', classification: 'static' }),
      route({ pathname: '/blog', kind: 'app-page', classification: 'static' }),
      route({ pathname: '/blog/[slug]', kind: 'app-page' }),
      route({ pathname: '/docs/[...path]', kind: 'app-page' }),
      route({ pathname: '/shop/[[...slug]]', kind: 'app-page' }),
      route({ pathname: '/api/users/[id]', kind: 'app-route', classification: 'route' }),
      route({ pathname: '/(marketing)/pricing', kind: 'app-page', classification: 'static' }),
      route({ pathname: '/robots.txt', kind: 'static-file', classification: 'asset' }),
    ],
  });
  const matcher = createRouteMatcher(manifest);

  it('matches static and dynamic routes with params', () => {
    expect(matcher.match('/')?.route.pathname).toBe('/');
    expect(matcher.match('/blog')?.route.pathname).toBe('/blog');
    expect(matcher.match('/blog/')?.route.pathname).toBe('/blog');
    expect(matcher.match('/blog/hello-world')).toMatchObject({
      route: { pathname: '/blog/[slug]' },
      params: { slug: 'hello-world' },
    });
    expect(matcher.match('/docs/a/b/c')?.params.path).toBe('a/b/c');
    expect(matcher.match('/shop')?.route.pathname).toBe('/shop/[[...slug]]');
    expect(matcher.match('/shop/x/y')?.params.slug).toBe('x/y');
    expect(matcher.match('/api/users/42')?.params.id).toBe('42');
    expect(matcher.match('/robots.txt')?.route.kind).toBe('static-file');
    expect(matcher.match('/nope')).toBeNull();
  });
  it('ignores route groups in patterns', () => {
    expect(routePatternToRegex('/(marketing)/pricing')).toBe('^/pricing(?:/)?$');
    expect(matcher.match('/pricing')?.route.classification).toBe('static');
  });
  it('respects basePath', () => {
    const m = createRouteMatcher({ ...manifest, basePath: '/app' });
    expect(m.match('/app/blog/x')?.params.slug).toBe('x');
  });
});

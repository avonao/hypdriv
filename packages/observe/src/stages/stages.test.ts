import {
  createContext,
  emptyManifest,
  flushContext,
  type HypDrivConfig,
  type HypRoute,
  parseServerTiming,
  resolveConfig,
  runPipeline,
  type Stage,
} from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { serverTimingMode } from '../server-timing';
import type { Span } from '../trace/span';
import { createTracer, type SpanExporter } from '../trace/tracer';
import { observeStage, VITALS_SINK_KEY } from './observe';
import { requestIdStage } from './request-id';
import { cacheStatusOf, maskIp, ROOT_SPAN_KEY, TRACE_KEY } from './shared';

const route: HypRoute = {
  id: 'app:/blog/[slug]',
  pathname: '/blog/[slug]',
  regex: '^/blog/(?<slug>[^/]+?)(?:/)?$',
  kind: 'app-page',
  classification: 'static',
  runtime: 'nodejs',
  dynamic: true,
  assets: { js: [], css: [], fonts: [] },
};

function harness(configInput: HypDrivConfig = {}, options: { tracer?: boolean; development?: boolean } = {}) {
  const config = resolveConfig(configInput);
  const exported: Span[] = [];
  const exporter: SpanExporter = {
    async export(spans) {
      exported.push(...spans);
    },
  };
  const tracer = options.tracer === false ? undefined : createTracer({ serviceName: 'svc', exporter });
  const lines: Record<string, unknown>[] = [];
  const log = createLogger(
    config.observe.logging,
    {},
    { sink: (l) => lines.push(JSON.parse(l)), clock: () => 'T' },
  );
  const stages: Stage[] = [requestIdStage(config, tracer), observeStage(config, { tracer })];

  async function run(
    url: string,
    init: RequestInit = {},
    next: (req: Request) => Response | Promise<Response> = () => new Response('ok'),
    extra: { middle?: Stage; ip?: string } = {},
  ) {
    const ctx = createContext({
      request: new Request(url, init),
      config,
      manifest: emptyManifest({ routes: [route] }),
      route: { route, params: { slug: 'x' } },
      log,
      development: options.development ?? false,
      ip: extra.ip ?? '203.0.113.42',
      runner: 'worker',
    });
    let forwarded: Request | undefined;
    const list = extra.middle ? [stages[0]!, extra.middle, stages[1]!] : stages;
    const result = await runPipeline({
      stages: list,
      ctx,
      next: async (req) => {
        forwarded = req;
        return next(req);
      },
    });
    await flushContext(ctx);
    return { ...result, ctx, forwarded: forwarded!, exported, lines };
  }
  return { run, config, tracer, exported, lines };
}

describe('requestIdStage', () => {
  it('assigns ids, forwards traceparent and request id to Next, and stamps the response', async () => {
    const h = harness();
    const r = await h.run(
      'https://x.test/blog/x?q=1',
      {},
      () => new Response('ok', { headers: { 'x-hypdriv-cache': 'HIT' } }),
    );
    const trace = r.ctx.state.get(TRACE_KEY)!;
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.sampled).toBe(true);
    expect(r.forwarded.headers.get('x-hypdriv-request-id')).toBe(r.ctx.id);
    expect(r.forwarded.headers.get('traceparent')).toBe(`00-${trace.traceId}-${trace.spanId}-01`);
    expect(r.response.headers.get('x-request-id')).toBe(r.ctx.id);
    expect(r.response.headers.get('x-hypdriv-request-id')).toBe(r.ctx.id);
    const timing = parseServerTiming(r.response.headers.get('server-timing'));
    expect(timing.map((t) => t.name)).toContain('total');
    expect(timing.find((t) => t.name === 'next')).toBeDefined();

    expect(r.exported).toHaveLength(1);
    const span = r.exported[0]!;
    expect(span.name).toBe('http.request');
    expect(span.kind).toBe('server');
    expect(span.endTime).toBeDefined();
    expect(span.status).toBe('ok');
    expect(span.attributes).toMatchObject({
      'http.method': 'GET',
      'http.target': '/blog/x?q=1',
      'http.host': 'x.test',
      'http.scheme': 'https',
      'http.status_code': 200,
      'route.id': 'app:/blog/[slug]',
      'http.route': '/blog/[slug]',
      'hypdriv.cache': 'HIT',
      'hypdriv.request_id': r.ctx.id,
      'hypdriv.runner': 'worker',
    });
    expect(r.ctx.state.get(ROOT_SPAN_KEY)).toBe(span);
  });

  it('continues an incoming traceparent, including its sampling flag, and marks 5xx spans as errors', async () => {
    const h = harness();
    const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
    const r = await h.run(
      'https://x.test/blog/x',
      { headers: { traceparent: incoming } },
      () => new Response('down', { status: 503 }),
    );
    const trace = r.ctx.state.get(TRACE_KEY)!;
    expect(trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(trace.sampled).toBe(false);
    expect(r.forwarded.headers.get('traceparent')).toBe(
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${trace.spanId}-00`,
    );
    expect(r.exported).toHaveLength(0); // unsampled
    const root = r.ctx.state.get(ROOT_SPAN_KEY)!;
    expect(root.parentSpanId).toBe('00f067aa0ba902b7');
    expect(root.status).toBe('error');
    expect(root.attributes['http.status_code']).toBe(503);
  });

  it('works without a tracer and keeps an existing x-request-id', async () => {
    const h = harness({}, { tracer: false });
    const r = await h.run(
      'https://x.test/blog/x',
      {},
      () => new Response('ok', { headers: { 'x-request-id': 'app-1' } }),
    );
    const trace = r.ctx.state.get(TRACE_KEY)!;
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.forwarded.headers.get('traceparent')).toBe(`00-${trace.traceId}-${trace.spanId}-01`);
    expect(r.response.headers.get('x-request-id')).toBe('app-1');
    expect(r.response.headers.get('x-hypdriv-request-id')).toBe(r.ctx.id);
    expect(r.ctx.state.get(ROOT_SPAN_KEY)).toBeUndefined();
  });

  it('binds requestId and traceId to the request logger', async () => {
    const h = harness();
    let seen: Record<string, unknown> | undefined;
    const middle: Stage = {
      name: 'probe',
      pre(ctx) {
        ctx.log.info('probe');
        seen = h.lines.find((l) => l.msg === 'probe');
      },
    };
    const r = await h.run('https://x.test/blog/x', {}, undefined, { middle });
    expect(seen).toMatchObject({ requestId: r.ctx.id, traceId: r.ctx.state.get(TRACE_KEY)!.traceId });
  });

  it('honours Server-Timing modes', async () => {
    const compact = await harness({}).run('https://x.test/blog/x');
    const names = parseServerTiming(compact.response.headers.get('server-timing')).map((t) => t.name);
    expect(names).toEqual(['next', 'total']);
    const verbose = await harness({}, { development: true }).run('https://x.test/blog/x');
    expect(parseServerTiming(verbose.response.headers.get('server-timing')).map((t) => t.name)).toEqual([
      'request-id',
      'observe',
      'next',
      'observe.post',
      'total',
    ]);
    const forced = await harness({ observe: { serverTiming: 'verbose' } }).run('https://x.test/blog/x');
    expect(parseServerTiming(forced.response.headers.get('server-timing')).length).toBeGreaterThan(2);
    const off = await harness({ observe: { serverTiming: false } }).run('https://x.test/blog/x');
    expect(off.response.headers.get('server-timing')).toBeNull();
    const dev = resolveConfig({});
    expect(serverTimingMode(dev, true)).toBe('verbose');
    expect(serverTimingMode(dev, false)).toBe('compact');
    expect(serverTimingMode(resolveConfig({ observe: { serverTiming: 'compact' } }), true)).toBe('compact');
  });

  it('runs on internal paths', async () => {
    const h = harness();
    const r = await h.run('https://x.test/_next/static/chunk.js');
    expect(r.response.headers.get('x-hypdriv-request-id')).toBe(r.ctx.id);
    expect(r.ran).toEqual(['request-id', 'observe']);
  });
});

describe('observeStage', () => {
  it('logs a request summary with masked ip, cache status and bot verdict, and flushes spans after the root ends', async () => {
    const h = harness();
    const middle: Stage = {
      name: 'edge-cache',
      pre(ctx) {
        ctx.timings.mark('cache', 'MISS');
      },
    };
    const r = await h.run(
      'https://x.test/blog/x?secret=1',
      { method: 'POST' },
      () => new Response('ok', { status: 201, headers: { 'x-hypdriv-bot': 'human' } }),
      { middle, ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348' },
    );
    const line = h.lines.find((l) => l.msg === 'request')!;
    expect(line).toMatchObject({
      level: 'info',
      method: 'POST',
      path: '/blog/x',
      status: 201,
      route: 'app:/blog/[slug]',
      cache: 'MISS',
      bot: 'human',
      ip: '2001:db8:85a3:8d3::',
      runner: 'worker',
      requestId: r.ctx.id,
    });
    expect(typeof line.duration).toBe('number');
    expect(line.path).not.toContain('secret');
    expect(r.exported).toHaveLength(1);
    expect(r.exported[0]!.attributes['hypdriv.cache']).toBe('MISS');
  });

  it('can be silenced and exposes the vitals sink', async () => {
    const h = harness({ observe: { logging: { requests: false } } });
    const r = await h.run('https://x.test/blog/x');
    expect(h.lines.find((l) => l.msg === 'request')).toBeUndefined();
    expect(r.exported).toHaveLength(1);

    const config = resolveConfig({});
    const sink = { write() {} };
    const stage = observeStage(config, { vitalsSink: sink });
    const ctx = createContext({ request: new Request('https://x.test/'), config });
    await runPipeline({ stages: [stage], ctx, next: async () => new Response('ok') });
    expect(ctx.state.get(VITALS_SINK_KEY)).toBe(sink);
  });

  it('helpers: cacheStatusOf prefers the header, maskIp handles both families', () => {
    const config = resolveConfig({});
    const ctx = createContext({ request: new Request('https://x.test/'), config });
    expect(cacheStatusOf(ctx)).toBeUndefined();
    ctx.timings.mark('cache', 'MISS');
    ctx.timings.mark('cache', 'ERROR-STALE');
    expect(cacheStatusOf(ctx)).toBe('ERROR-STALE');
    expect(cacheStatusOf(ctx, new Response('', { headers: { 'x-hypdriv-cache': 'HIT' } }))).toBe('HIT');
    expect(maskIp('203.0.113.42')).toBe('203.0.113.0');
    expect(maskIp('::1')).toBe('0:0:0:0::');
    expect(maskIp('2001:db8::1')).toBe('2001:db8:0:0::');
    expect(maskIp('weird')).toBe('weird');
    expect(maskIp(undefined)).toBeUndefined();
  });
});

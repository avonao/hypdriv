import { describe, expect, it, vi } from 'vitest';
import {
  analyticsEngineExporter,
  consoleExporter,
  noopExporter,
  otlpHttpExporter,
  otlpTracesUrl,
  otlpValue,
  toOtlpPayload,
  toUnixNano,
} from './exporters';
import type { Span } from './span';
import { createTracer, formatTraceparent, parseTraceparent, type SpanExporter, sampleTrace } from './tracer';

function memoryExporter() {
  const batches: Array<{ spans: Span[]; resource?: Record<string, string> }> = [];
  const exporter: SpanExporter = {
    async export(spans, resource) {
      batches.push({ spans, resource });
    },
  };
  return { batches, exporter, spans: () => batches.flatMap((b) => b.spans) };
}

describe('traceparent', () => {
  it('parses valid headers and rejects malformed ones', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(parseTraceparent(' 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-00 ')?.sampled).toBe(
      false,
    );
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('00-abc-def-01')).toBeNull();
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
  });
  it('formats version 00 headers', () => {
    expect(formatTraceparent({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true })).toBe(
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    );
    expect(formatTraceparent({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: false })).toMatch(
      /-00$/,
    );
  });
  it('samples deterministically by trace id', () => {
    expect(sampleTrace('0'.repeat(32), 0.5)).toBe(true);
    expect(sampleTrace('f'.repeat(32), 0.5)).toBe(false);
    expect(sampleTrace('f'.repeat(32), 1)).toBe(true);
    expect(sampleTrace('0'.repeat(32), 0)).toBe(false);
  });
});

describe('createTracer', () => {
  it('creates root and child spans, inherits sampling from the parent and formats traceparent', () => {
    let t = 1_700_000_000_000;
    const { exporter } = memoryExporter();
    const tracer = createTracer({ serviceName: 'svc', exporter, now: () => t });
    const root = tracer.startSpan('http.request', { kind: 'server', attributes: { 'http.method': 'GET' } });
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.sampled).toBe(true);
    expect(root.kind).toBe('server');
    expect(root.attributes).toEqual({ 'http.method': 'GET' });
    const child = tracer.startSpan('render', { parent: root });
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.kind).toBe('internal');
    expect(tracer.traceparent(root)).toBe(`00-${root.traceId}-${root.spanId}-01`);

    const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
    const continued = tracer.startSpan('http.request', { parent: incoming });
    expect(continued.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(continued.parentSpanId).toBe('00f067aa0ba902b7');
    expect(continued.sampled).toBe(false);
    expect(tracer.traceparent(continued)).toMatch(/-00$/);
    const grandchild = tracer.startSpan('x', { parent: continued });
    expect(grandchild.sampled).toBe(false);

    t += 12.5;
    root.end();
    expect(root.endTime).toBe(t);
    expect(root.duration()).toBe(12.5);
    root.end(); // idempotent
    expect(root.endTime).toBe(t);
  });

  it('records exceptions in withSpan and buffers only sampled, ended spans for flush', async () => {
    const mem = memoryExporter();
    const tracer = createTracer({
      serviceName: 'svc',
      exporter: mem.exporter,
      resource: { 'deployment.environment': 'test' },
    });
    await expect(
      tracer.withSpan('boom', async (span) => {
        span.setAttribute('a', 1);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const ok = await tracer.withSpan('fine', () => 42);
    expect(ok).toBe(42);
    const open = tracer.startSpan('open');
    const unsampled = tracer.startSpan('skip', {
      parent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
    });
    unsampled.end();
    expect(tracer.pending).toBe(2);
    await tracer.flush();
    expect(mem.batches).toHaveLength(1);
    expect(mem.batches[0]!.resource).toMatchObject({
      'service.name': 'svc',
      'deployment.environment': 'test',
      'telemetry.sdk.name': 'hypdriv',
    });
    const [boom, fine] = mem.batches[0]!.spans;
    expect(boom!.name).toBe('boom');
    expect(boom!.status).toBe('error');
    expect(boom!.statusMessage).toBe('nope');
    expect(boom!.events[0]).toMatchObject({
      name: 'exception',
      attributes: { 'exception.type': 'Error', 'exception.message': 'nope' },
    });
    expect(boom!.events[0]!.attributes!['exception.stacktrace']).toContain('nope');
    expect(fine!.status).toBe('unset');
    expect(tracer.pending).toBe(0);
    await tracer.flush();
    expect(mem.batches).toHaveLength(1);
    open.end();
    await tracer.flush();
    expect(mem.batches).toHaveLength(2);
  });

  it('never throws from flush and bounds the buffer', async () => {
    const warn = vi.fn();
    const log = {
      level: 'warn' as const,
      debug() {},
      info() {},
      warn,
      error() {},
      child() {
        return log;
      },
    };
    const failing: SpanExporter = {
      export: async () => {
        throw new Error('offline');
      },
    };
    const tracer = createTracer({ serviceName: 's', exporter: failing, maxBuffer: 2, log });
    for (let i = 0; i < 3; i++) tracer.startSpan(`s${i}`).end();
    expect(tracer.pending).toBe(2);
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('tracer: span buffer overflowed', { dropped: 1 });
    expect(warn).toHaveBeenCalledWith('tracer: export failed', expect.objectContaining({ error: 'offline' }));
  });

  it('caps attributes and events and fires onEnd listeners once', () => {
    const tracer = createTracer({ serviceName: 's', exporter: noopExporter() });
    const span = tracer.startSpan('x');
    for (let i = 0; i < 200; i++) span.setAttribute(`k${i}`, i);
    expect(Object.keys(span.attributes)).toHaveLength(128);
    span.setAttribute('long', 'x'.repeat(5000));
    expect(span.attributes.long as string | undefined).toBeUndefined(); // over the attribute cap
    span.setAttribute('k0', 'y'.repeat(5000));
    expect((span.attributes.k0 as string).length).toBe(4096);
    for (let i = 0; i < 200; i++) span.addEvent('e');
    expect(span.events).toHaveLength(128);
    const seen: string[] = [];
    span.onEnd(() => seen.push('a'));
    span.end();
    span.onEnd(() => seen.push('b'));
    span.end();
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('OTLP/HTTP JSON exporter', () => {
  it('encodes values, timestamps and the traces URL', () => {
    expect(otlpValue('a')).toEqual({ stringValue: 'a' });
    expect(otlpValue(3)).toEqual({ intValue: '3' });
    expect(otlpValue(3.5)).toEqual({ doubleValue: 3.5 });
    expect(otlpValue(true)).toEqual({ boolValue: true });
    expect(toUnixNano(1_700_000_000_000)).toBe('1700000000000000000');
    expect(toUnixNano(1_700_000_000_000.5)).toBe('1700000000000500000');
    expect(toUnixNano(1_700_000_000_000.25)).toBe('1700000000000250000');
    expect(otlpTracesUrl('https://api.honeycomb.io')).toBe('https://api.honeycomb.io/v1/traces');
    expect(otlpTracesUrl('https://otlp.example.net/otlp/')).toBe('https://otlp.example.net/otlp/v1/traces');
    expect(otlpTracesUrl('https://otlp.example.net/v1/traces')).toBe('https://otlp.example.net/v1/traces');
  });

  it('produces the resourceSpans/scopeSpans/spans payload precisely', async () => {
    let t = 1_700_000_000_000;
    const tracer = createTracer({ serviceName: 'svc', exporter: noopExporter(), now: () => t });
    const root = tracer.startSpan('http.request', {
      kind: 'server',
      attributes: { 'http.method': 'GET', 'http.status_code': 200, ratio: 0.5, ok: true },
    });
    t += 5;
    const child = tracer.startSpan('db', { parent: root });
    child.addEvent('query', { rows: 3 });
    t += 2;
    child.setStatus('error', 'timeout');
    child.end();
    t += 3;
    root.setStatus('ok');
    root.end();
    const payload = toOtlpPayload([root, child], { 'service.name': 'svc' });
    expect(payload).toEqual({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
          scopeSpans: [
            {
              scope: { name: '@hypdriv/observe', version: expect.any(String) },
              spans: [
                {
                  traceId: root.traceId,
                  spanId: root.spanId,
                  name: 'http.request',
                  kind: 2,
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000010000000',
                  attributes: [
                    { key: 'http.method', value: { stringValue: 'GET' } },
                    { key: 'http.status_code', value: { intValue: '200' } },
                    { key: 'ratio', value: { doubleValue: 0.5 } },
                    { key: 'ok', value: { boolValue: true } },
                  ],
                  events: [],
                  status: { code: 1 },
                },
                {
                  traceId: root.traceId,
                  spanId: child.spanId,
                  parentSpanId: root.spanId,
                  name: 'db',
                  kind: 1,
                  startTimeUnixNano: '1700000000005000000',
                  endTimeUnixNano: '1700000000007000000',
                  attributes: [],
                  events: [
                    {
                      timeUnixNano: '1700000000005000000',
                      name: 'query',
                      attributes: [{ key: 'rows', value: { intValue: '3' } }],
                    },
                  ],
                  status: { code: 2, message: 'timeout' },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('posts batches with headers and a timeout, swallowing failures and logging once per minute', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(status === 200 ? '{}' : 'bad', { status });
    }) as typeof fetch;
    const warn = vi.fn();
    const log = {
      level: 'warn' as const,
      debug() {},
      info() {},
      warn,
      error() {},
      child() {
        return log;
      },
    };
    const exporter = otlpHttpExporter({
      url: 'https://collector.test',
      headers: { 'x-honeycomb-team': 'k' },
      fetch: fetchImpl,
      batchSize: 2,
      log,
      timeoutMs: 1000,
    });
    const tracer = createTracer({ serviceName: 'svc', exporter: noopExporter() });
    const spans = [1, 2, 3].map((i) => {
      const s = tracer.startSpan(`s${i}`);
      s.end();
      return s;
    });
    await exporter.export(spans, { 'service.name': 'svc' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://collector.test/v1/traces');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['x-honeycomb-team']).toBe('k');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init.body)).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);

    status = 500;
    await exporter.export(spans.slice(0, 1));
    await exporter.export(spans.slice(0, 1));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ status: 500, spans: 1 });

    const offline = otlpHttpExporter({
      url: 'https://collector.test',
      log,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    await expect(offline.export(spans)).resolves.toBeUndefined();
  });
});

describe('console and Analytics Engine exporters', () => {
  it('writes one compact JSON line per span', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ sink: (l) => lines.push(l) });
    const tracer = createTracer({ serviceName: 'svc', exporter, now: () => 1_700_000_000_000 });
    const span = tracer.startSpan('x', { attributes: { a: 1 } });
    span.addEvent('e');
    span.end();
    await tracer.flush();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      type: 'span',
      service: 'svc',
      name: 'x',
      kind: 'internal',
      durationMs: 0,
      status: 'unset',
      attributes: { a: 1 },
      start: '2023-11-14T22:13:20.000Z',
    });
    expect(parsed.events).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
  });

  it('writes data points with the documented layout', async () => {
    const points: Array<{ indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }> = [];
    const exporter = analyticsEngineExporter({ writeDataPoint: (p) => void points.push(p) });
    let t = 10;
    const tracer = createTracer({ serviceName: 'svc', exporter, now: () => t });
    const root = tracer.startSpan('http.request', { attributes: { 'route.id': 'app:/x' } });
    const child = tracer.startSpan('child', { parent: root });
    t = 15;
    child.setStatus('error');
    child.end();
    root.end();
    await tracer.flush();
    expect(points).toEqual([
      { indexes: [root.traceId], blobs: ['child', child.spanId, root.spanId, 'error', ''], doubles: [5, 10] },
      {
        indexes: [root.traceId],
        blobs: ['http.request', root.spanId, '', 'unset', 'app:/x'],
        doubles: [5, 10],
      },
    ]);
  });
});

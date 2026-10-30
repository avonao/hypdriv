import { describe, expect, it, vi } from 'vitest';
import { onRequestError, type RequestErrorEvent } from './errors';
import type { Span } from './trace/span';
import { createTracer } from './trace/tracer';

describe('onRequestError', () => {
  const request = {
    path: '/blog/x',
    method: 'GET',
    headers: {
      cookie: 'session=secret',
      authorization: 'Bearer t',
      'user-agent': 'UA/1',
      referer: 'https://x.test/',
      'x-hypdriv-request-id': 'req-1',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    },
  };
  const context = {
    routerKind: 'App Router',
    routePath: '/blog/[slug]',
    routeType: 'render',
    renderSource: 'react-server-components',
    revalidateReason: undefined,
  };

  it('logs with redaction, records a span event and forwards to the sink', async () => {
    const errorLog = vi.fn();
    const log = {
      level: 'info' as const,
      debug() {},
      info() {},
      warn() {},
      error: errorLog,
      child() {
        return log;
      },
    };
    const exported: Span[] = [];
    const tracer = createTracer({
      serviceName: 'svc',
      exporter: { export: async (s) => void exported.push(...s) },
    });
    const events: RequestErrorEvent[] = [];
    const hook = onRequestError({
      tracer,
      log,
      sink: (e) => void events.push(e),
      redactKeys: ['referer'],
      now: () => 123,
    });
    const err = Object.assign(new Error('render failed'), { digest: 'D1', code: 'E_X' });
    await hook(err, request, context);

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message, fields] = errorLog.mock.calls[0]!;
    expect(message).toBe('request error');
    expect(fields).toMatchObject({
      message: 'render failed',
      name: 'Error',
      digest: 'D1',
      code: 'E_X',
      path: '/blog/x',
      method: 'GET',
      routerKind: 'App Router',
      routePath: '/blog/[slug]',
      routeType: 'render',
      renderSource: 'react-server-components',
      requestId: 'req-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      userAgent: 'UA/1',
      referer: '[redacted]',
      ts: 123,
    });
    expect(String(fields.stack)).toContain('render failed');
    expect(JSON.stringify(fields)).not.toContain('secret');

    expect(exported).toHaveLength(1);
    const span = exported[0]!;
    expect(span.name).toBe('next.request-error');
    expect(span.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span.parentSpanId).toBe('00f067aa0ba902b7');
    expect(span.status).toBe('error');
    expect(span.events[0]).toMatchObject({
      name: 'exception',
      attributes: { 'exception.message': 'render failed', 'exception.code': 'E_X' },
    });
    expect(span.attributes).toMatchObject({
      'next.route_path': '/blog/[slug]',
      'next.digest': 'D1',
      'hypdriv.request_id': 'req-1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.headers).toMatchObject({
      cookie: '[redacted]',
      authorization: '[redacted]',
      'user-agent': 'UA/1',
    });
    expect(events[0]!.stack).toBeDefined();
  });

  it('never throws, accepts Headers instances and non-Error values, and can omit stacks', async () => {
    const log = {
      level: 'info' as const,
      debug() {},
      info() {},
      warn() {},
      error() {
        throw new Error('logger broke');
      },
      child() {
        return log;
      },
    };
    const hook = onRequestError({
      log,
      sink: () => {
        throw new Error('sink broke');
      },
    });
    await expect(
      hook('string error', { ...request, headers: new Headers({ cookie: 'a=b' }) }, context),
    ).resolves.toBeUndefined();

    const events: RequestErrorEvent[] = [];
    const quiet = { ...log, error() {} };
    const hook2 = onRequestError({ log: quiet, sink: (e) => void events.push(e), includeStack: false });
    await hook2(
      { weird: true },
      { ...request, headers: new Headers({ cookie: 'a=b' }) },
      { routerKind: 'Pages Router', routePath: '/p', routeType: 'route' },
    );
    expect(events[0]).toMatchObject({
      message: '{"weird":true}',
      name: 'Error',
      headers: { cookie: '[redacted]' },
      routerKind: 'Pages Router',
    });
    expect(events[0]!.stack).toBeUndefined();
    expect(events[0]!.traceId).toBeUndefined();
  });
});

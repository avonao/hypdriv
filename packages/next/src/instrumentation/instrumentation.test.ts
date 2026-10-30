import type { Logger } from '@hypdriv/core';
import type { RequestErrorEvent, Span, SpanExporter } from '@hypdriv/observe';
import { createTracer } from '@hypdriv/observe';
import { describe, expect, it, vi } from 'vitest';
import { createClientInstrumentation, createInstrumentation } from './index';

function memoryLogger() {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const make = (): Logger => ({
    level: 'debug',
    debug: (message, fields) => lines.push({ level: 'debug', message, ...(fields ? { fields } : {}) }),
    info: (message, fields) => lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => lines.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
    child: () => make(),
  });
  return { log: make(), lines };
}

const request = {
  path: '/checkout',
  method: 'POST',
  headers: { 'x-hypdriv-request-id': 'req-42', authorization: 'Bearer secret', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
};
const context = { routerKind: 'App Router', routePath: '/checkout', routeType: 'render' };

describe('createInstrumentation', () => {
  it('logs request errors with redacted headers and forwards them to the sink', async () => {
    const { log, lines } = memoryLogger();
    const events: RequestErrorEvent[] = [];
    const { onRequestError, register } = createInstrumentation({ log, sink: (e) => void events.push(e) });
    await register();
    await onRequestError(Object.assign(new Error('payment failed'), { digest: 'd1' }), request, context);
    const error = lines.find((l) => l.level === 'error');
    expect(error?.message).toBe('request error');
    expect(error?.fields).toMatchObject({ message: 'payment failed', path: '/checkout', requestId: 'req-42', digest: 'd1' });
    expect(events).toHaveLength(1);
    expect(events[0]?.headers.authorization).toBe('[redacted]');
    expect(events[0]?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('records an exception span parented to the request trace when errors go to OTLP', async () => {
    const exported: Span[] = [];
    const exporter: SpanExporter = { async export(spans) { exported.push(...spans); } };
    const tracer = createTracer({ serviceName: 'shop', exporter });
    const { log } = memoryLogger();
    const { onRequestError } = createInstrumentation({ log, tracer, config: { observe: { errors: { sink: 'otlp' } } } });
    await onRequestError(new Error('boom'), request, context);
    expect(exported).toHaveLength(1);
    expect(exported[0]?.name).toBe('next.request-error');
    expect(exported[0]?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('warns once when OTLP errors are requested without tracing', async () => {
    const { log, lines } = memoryLogger();
    const { onRequestError } = createInstrumentation({ log, env: {}, config: { observe: { tracing: false, errors: { sink: 'otlp' } } } });
    await onRequestError(new Error('a'), request, context);
    await onRequestError(new Error('b'), request, context);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  });

  it('is a no-op when the error sink is disabled', async () => {
    const { log, lines } = memoryLogger();
    const sink = vi.fn();
    const { onRequestError } = createInstrumentation({ log, sink, config: { observe: { errors: { sink: 'none' } } } });
    await onRequestError(new Error('ignored'), request, context);
    expect(lines).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it('never throws into Next.js', async () => {
    const { log } = memoryLogger();
    const { onRequestError } = createInstrumentation({
      log,
      sink: () => {
        throw new Error('sink down');
      },
    });
    await expect(onRequestError('not an error', request, context)).resolves.toBeUndefined();
  });
});

describe('createClientInstrumentation', () => {
  it('reports navigation durations', () => {
    const log = vi.fn();
    const client = createClientInstrumentation({ log });
    client.onRouterTransitionStart('/pricing', 'push');
    expect(typeof client.onRouterTransitionStart).toBe('function');
  });
});

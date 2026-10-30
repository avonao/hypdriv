import {
  createSpanId,
  createTraceId,
  defineStage,
  HEADER,
  type ResolvedConfig,
  type Stage,
  withHeaders,
} from '@hypdriv/core';
import { serverTimingMode } from '../server-timing';
import { formatTraceparent, parseTraceparent, type Tracer } from '../trace/tracer';
import { cacheStatusOf, ROOT_SPAN_KEY, TRACE_KEY } from './shared';

/**
 * The `request-id` stage (first in the Drivetrain): assigns trace ids (continuing an incoming
 * `traceparent`), starts the root `http.request` span, binds `requestId`/`traceId` to `ctx.log`,
 * forwards `x-hypdriv-request-id` + `traceparent` to Next.js, and in `post` sets `x-request-id`,
 * `x-hypdriv-request-id` and `Server-Timing` and ends the span with the response status.
 */
export function requestIdStage(config: ResolvedConfig, tracer?: Tracer): Stage {
  return defineStage({
    name: 'request-id',
    runOnInternal: true,
    pre(ctx) {
      const incoming = ctx.request.headers.get('traceparent');
      const parent = parseTraceparent(incoming);
      let trace: { traceId: string; spanId: string; sampled: boolean };
      if (tracer) {
        const span = tracer.startSpan('http.request', {
          parent: parent ? incoming : undefined,
          kind: 'server',
          attributes: {
            'http.method': ctx.request.method,
            'http.target': ctx.url.pathname + ctx.url.search,
            'http.host': ctx.url.host,
            'http.scheme': ctx.url.protocol.replace(':', ''),
            'hypdriv.request_id': ctx.id,
            'hypdriv.runner': ctx.runner,
          },
        });
        ctx.state.set(ROOT_SPAN_KEY, span);
        trace = { traceId: span.traceId, spanId: span.spanId, sampled: span.sampled };
      } else {
        trace = {
          traceId: parent?.traceId ?? createTraceId(),
          spanId: createSpanId(),
          sampled: parent?.sampled ?? true,
        };
      }
      ctx.state.set(TRACE_KEY, trace);
      ctx.log = ctx.log.child({ requestId: ctx.id, traceId: trace.traceId });
      ctx.requestHeaders.set(HEADER.hypRequestId, ctx.id);
      ctx.requestHeaders.set('traceparent', formatTraceparent(trace));
    },
    post(ctx, response) {
      const headers: Record<string, string> = { [HEADER.hypRequestId]: ctx.id };
      if (!response.headers.has(HEADER.requestId)) headers[HEADER.requestId] = ctx.id;
      const mode = serverTimingMode(config, ctx.development);
      if (mode !== 'off') {
        const value = ctx.timings.toHeader(mode);
        if (value) headers['server-timing'] = value;
      }
      const span = ctx.state.get(ROOT_SPAN_KEY);
      if (span) {
        span.setAttribute('http.status_code', response.status);
        if (ctx.route) {
          span.setAttribute('route.id', ctx.route.route.id);
          span.setAttribute('http.route', ctx.route.route.pathname);
        }
        const cache = cacheStatusOf(ctx, response);
        if (cache) span.setAttribute('hypdriv.cache', cache);
        span.setStatus(response.status >= 500 ? 'error' : 'ok');
        span.end();
      }
      return withHeaders(response, headers);
    },
  });
}

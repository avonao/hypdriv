import { type Logger, toError } from '@hypdriv/core';
import { redact, redactHeaders } from './logger';
import { parseTraceparent, type Tracer } from './trace/tracer';

/** The `request` argument Next.js passes to `instrumentation.ts#onRequestError`. */
export interface NextErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined> | Headers;
}

/** The `context` argument Next.js passes to `instrumentation.ts#onRequestError`. */
export interface NextErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
}

/** Normalised error event handed to the sink. */
export interface RequestErrorEvent {
  message: string;
  name: string;
  stack?: string;
  digest?: string;
  code?: string | number;
  path: string;
  method: string;
  headers: Record<string, string>;
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
  requestId?: string;
  traceId?: string;
  ts: number;
}

export interface OnRequestErrorOptions {
  tracer?: Tracer;
  log: Logger;
  /** Forwarding target (error tracker, queue, Analytics Engine...). */
  sink?: (event: RequestErrorEvent) => void | Promise<void>;
  /** Include stack traces in logs and events (default true). */
  includeStack?: boolean;
  /** Extra field names to redact (`observe.logging.redact`). */
  redactKeys?: string[];
  now?: () => number;
}

export type NextOnRequestError = (
  error: unknown,
  request: NextErrorRequest,
  context: NextErrorContext,
) => Promise<void>;

/**
 * Builds Next's `onRequestError` hook: logs the error with redacted headers, records it as an
 * `exception` event on a span parented to the request's `traceparent` (forwarded by the
 * `request-id` stage) and forwards a normalised event to the sink. Never throws.
 */
export function onRequestError(options: OnRequestErrorOptions): NextOnRequestError {
  const includeStack = options.includeStack ?? true;
  const now = options.now ?? Date.now;
  return async (error, request, context) => {
    try {
      const err = toError(error);
      const headers = redactHeaders(request.headers ?? {}, options.redactKeys);
      const digest = (error as { digest?: unknown } | null)?.digest;
      const code = (error as { code?: unknown } | null)?.code;
      const traceparent = headers.traceparent;
      const event: RequestErrorEvent = {
        message: err.message,
        name: err.name,
        ...(includeStack && err.stack ? { stack: err.stack } : {}),
        ...(typeof digest === 'string' ? { digest } : {}),
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
        path: request.path,
        method: request.method,
        headers,
        routerKind: context.routerKind,
        routePath: context.routePath,
        routeType: context.routeType,
        ...(context.renderSource ? { renderSource: context.renderSource } : {}),
        ...(context.revalidateReason ? { revalidateReason: context.revalidateReason } : {}),
        ts: now(),
      };
      const requestId = headers['x-hypdriv-request-id'] ?? headers['x-request-id'];
      if (requestId) event.requestId = requestId;
      const parent = parseTraceparent(traceparent);
      if (parent) event.traceId = parent.traceId;

      const { headers: _headers, stack, ...fields } = event;
      options.log.error(
        'request error',
        redact(
          {
            ...fields,
            ...(stack ? { stack } : {}),
            userAgent: headers['user-agent'],
            referer: headers.referer,
          },
          options.redactKeys,
        ),
      );

      if (options.tracer) {
        const span = options.tracer.startSpan('next.request-error', {
          parent: traceparent ?? null,
          kind: 'internal',
          attributes: {
            'http.method': request.method,
            'http.target': request.path,
            'next.router_kind': context.routerKind,
            'next.route_path': context.routePath,
            'next.route_type': context.routeType,
            ...(context.renderSource ? { 'next.render_source': context.renderSource } : {}),
            ...(context.revalidateReason ? { 'next.revalidate_reason': context.revalidateReason } : {}),
            ...(typeof digest === 'string' ? { 'next.digest': digest } : {}),
            ...(requestId ? { 'hypdriv.request_id': requestId } : {}),
          },
        });
        span.recordException(err);
        span.end();
        await options.tracer.flush();
      }
      await options.sink?.(event);
    } catch {
      // An error hook must never throw into Next.js.
    }
  };
}

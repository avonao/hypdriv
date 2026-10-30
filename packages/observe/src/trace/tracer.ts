import { createSpanId, createTraceId, HYPDRIV_VERSION, type Logger, toError } from '@hypdriv/core';
import { type Attributes, type Span, type SpanKind, SpanImpl } from './span';

export interface TraceContext {
  traceId: string;
  parentId: string;
  sampled: boolean;
}

/** Receives ended, sampled spans in batches. `resource` carries `service.name` and friends. */
export interface SpanExporter {
  export(spans: Span[], resource?: Record<string, string>): Promise<void>;
}

export interface StartSpanOptions {
  /** Parent span, or an incoming `traceparent` header value. */
  parent?: Span | string | null;
  attributes?: Attributes;
  kind?: SpanKind;
  /** Start time in epoch ms (defaults to now). */
  start?: number;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
  /** Runs `fn` inside a span; exceptions are recorded (status error + `exception` event) and rethrown. */
  withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, options?: StartSpanOptions): Promise<T>;
  /** Exports every ended, sampled span buffered so far. Never throws. */
  flush(): Promise<void>;
  /** W3C `traceparent` for a span (`00-<traceId>-<spanId>-<flags>`). */
  traceparent(span: Span): string;
  readonly serviceName: string;
  readonly resource: Record<string, string>;
  /** Number of ended spans waiting for `flush()`. */
  readonly pending: number;
}

export interface TracerOptions {
  serviceName: string;
  exporter: SpanExporter;
  /** Head sampling ratio for new traces, 0..1 (default 1). Incoming `traceparent` flags win. */
  sampleRate?: number;
  resource?: Record<string, string>;
  /** Clock in epoch ms (tests). */
  now?: () => number;
  /** Max buffered spans before the oldest are dropped (default 2000). */
  maxBuffer?: number;
  log?: Logger;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parses a W3C `traceparent` header; returns null when absent or malformed. */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m;
  if (version === 'ff' || /^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return null;
  return { traceId: traceId!, parentId: parentId!, sampled: (Number.parseInt(flags!, 16) & 0x01) === 1 };
}

/** Formats a W3C `traceparent` header (version 00). */
export function formatTraceparent(ctx: { traceId: string; spanId: string; sampled: boolean }): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

/** Deterministic head sampling from the trace id (same idea as OpenTelemetry's TraceIdRatioBased sampler). */
export function sampleTrace(traceId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const tail = Number.parseInt(traceId.slice(-8), 16);
  return tail / 0x1_0000_0000 < sampleRate;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number'
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

/** Creates a tracer: spans buffer until `flush()` hands the sampled ones to the exporter in one batch. */
export function createTracer(options: TracerOptions): Tracer {
  const now = options.now ?? defaultNow;
  const sampleRate = options.sampleRate ?? 1;
  const maxBuffer = Math.max(1, options.maxBuffer ?? 2000);
  const resource: Record<string, string> = {
    'service.name': options.serviceName,
    'telemetry.sdk.name': 'hypdriv',
    'telemetry.sdk.language': 'webjs',
    'telemetry.sdk.version': HYPDRIV_VERSION,
    ...(options.resource ?? {}),
  };
  const buffer: Span[] = [];
  let dropped = 0;

  const onEnded = (span: SpanImpl) => {
    if (!span.sampled) return;
    if (buffer.length >= maxBuffer) {
      buffer.shift();
      dropped++;
    }
    buffer.push(span);
  };

  const tracer: Tracer = {
    serviceName: options.serviceName,
    resource,
    get pending() {
      return buffer.length;
    },
    startSpan(name, o = {}) {
      let traceId: string;
      let parentSpanId: string | undefined;
      let sampled: boolean;
      const parent = typeof o.parent === 'string' ? parseTraceparent(o.parent) : o.parent;
      if (parent && 'spanId' in parent) {
        traceId = parent.traceId;
        parentSpanId = parent.spanId;
        sampled = parent.sampled;
      } else if (parent) {
        traceId = parent.traceId;
        parentSpanId = parent.parentId;
        sampled = parent.sampled;
      } else {
        traceId = createTraceId();
        sampled = sampleTrace(traceId, sampleRate);
      }
      return new SpanImpl({
        traceId,
        spanId: createSpanId(),
        ...(parentSpanId ? { parentSpanId } : {}),
        name,
        kind: o.kind,
        start: o.start ?? now(),
        sampled,
        attributes: o.attributes,
        now,
        onEnded,
      });
    },
    async withSpan(name, fn, o) {
      const span = tracer.startSpan(name, o);
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    },
    async flush() {
      if (!buffer.length) return;
      const batch = buffer.splice(0, buffer.length);
      if (dropped) {
        options.log?.warn('tracer: span buffer overflowed', { dropped });
        dropped = 0;
      }
      try {
        await options.exporter.export(batch, resource);
      } catch (err) {
        options.log?.warn('tracer: export failed', { error: toError(err).message, spans: batch.length });
      }
    },
    traceparent(span) {
      return formatTraceparent(span);
    },
  };
  return tracer;
}

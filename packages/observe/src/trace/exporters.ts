import { type AnalyticsEngineLike, createConsoleLogger, HYPDRIV_VERSION, type Logger, toError } from '@hypdriv/core';
import type { AttributeValue, Attributes, Span, SpanKind } from './span';
import type { SpanExporter } from './tracer';

/** Exporter that drops everything (tracing disabled). */
export function noopExporter(): SpanExporter {
  return { async export() {} };
}

export interface ConsoleExporterOptions {
  /** Receives one compact JSON line per span (default `console.log`, which Workers Logs ingests). */
  sink?: (line: string) => void;
}

/** One JSON line per span, compact, for Workers Logs or any stdout collector. */
export function consoleExporter(options: ConsoleExporterOptions = {}): SpanExporter {
  const sink = options.sink ?? ((line: string) => console.log(line));
  return {
    async export(spans, resource) {
      const service = resource?.['service.name'];
      for (const span of spans) {
        sink(
          JSON.stringify({
            type: 'span',
            ...(service ? { service } : {}),
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind,
            start: new Date(span.start).toISOString(),
            durationMs: Number(span.duration().toFixed(3)),
            status: span.status,
            ...(span.statusMessage ? { statusMessage: span.statusMessage } : {}),
            attributes: span.attributes,
            ...(span.events.length ? { events: span.events } : {}),
          }),
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// OTLP/HTTP JSON (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
// ---------------------------------------------------------------------------------------------

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: Array<{ timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }>;
  status: { code: 0 | 1 | 2; message?: string };
}
export interface OtlpTracePayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
}

const SPAN_KINDS: Record<SpanKind, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const STATUS_CODES = { unset: 0, ok: 1, error: 2 } as const;

/** Encodes an attribute value in OTLP JSON form (int64 travels as a string per the proto3 JSON mapping). */
export function otlpValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: value };
}

export function otlpAttributes(attributes: Attributes | Record<string, string> | undefined): OtlpKeyValue[] {
  if (!attributes) return [];
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/** Epoch milliseconds (fractional) → nanoseconds as a decimal string without float precision loss. */
export function toUnixNano(ms: number): string {
  const whole = Math.floor(ms);
  const fraction = Math.round((ms - whole) * 1e6);
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
}

/** Builds the `/v1/traces` request body for a batch of spans. */
export function toOtlpPayload(spans: Span[], resource: Record<string, string> = {}): OtlpTracePayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeSpans: [
          {
            scope: { name: '@hypdriv/observe', version: HYPDRIV_VERSION },
            spans: spans.map((span): OtlpSpan => {
              const status: OtlpSpan['status'] = { code: STATUS_CODES[span.status] };
              if (span.statusMessage) status.message = span.statusMessage;
              return {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: SPAN_KINDS[span.kind] ?? 1,
                startTimeUnixNano: toUnixNano(span.start),
                endTimeUnixNano: toUnixNano(span.end ?? span.start),
                attributes: otlpAttributes(span.attributes),
                events: span.events.map((e) => ({
                  timeUnixNano: toUnixNano(e.time),
                  name: e.name,
                  attributes: otlpAttributes(e.attributes),
                })),
                status,
              };
            }),
          },
        ],
      },
    ],
  };
}

export interface OtlpHttpExporterOptions {
  /** Collector URL; `/v1/traces` is appended when the path does not already end with it. */
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Spans per HTTP request (default 512). */
  batchSize?: number;
  log?: Logger;
}

/** Resolves the traces endpoint from a base or full OTLP URL. */
export function otlpTracesUrl(url: string): string {
  const u = new URL(url);
  if (!u.pathname.replace(/\/+$/, '').endsWith('/v1/traces')) {
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/traces`;
  }
  return u.href;
}

/**
 * OTLP/HTTP JSON exporter for Honeycomb, Grafana, Axiom, Dash0 and any collector. Network and
 * collector errors are swallowed and logged at most once per minute, so tracing never affects requests.
 */
export function otlpHttpExporter(options: OtlpHttpExporterOptions): SpanExporter {
  const url = otlpTracesUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 5000;
  const batchSize = Math.max(1, options.batchSize ?? 512);
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? createConsoleLogger({ level: 'warn' });
  let lastErrorAt = 0;
  const reportError = (fields: Record<string, unknown>) => {
    const t = Date.now();
    if (t - lastErrorAt < 60_000) return;
    lastErrorAt = t;
    log.warn('otlp exporter: export failed', fields);
  };

  return {
    async export(spans, resource) {
      for (let i = 0; i < spans.length; i += batchSize) {
        const batch = spans.slice(i, i + batchSize);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
            body: JSON.stringify(toOtlpPayload(batch, resource)),
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            reportError({ status: res.status, body: text.slice(0, 200), spans: batch.length });
          } else {
            void res.body?.cancel().catch(() => undefined);
          }
        } catch (err) {
          reportError({ error: toError(err).message, spans: batch.length });
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Analytics Engine
// ---------------------------------------------------------------------------------------------

/**
 * Writes one data point per span: index `[traceId]`, blobs `[name, spanId, parentSpanId, status, route]`,
 * doubles `[durationMs, start]`. `dataset` is informational (datasets are bound in wrangler config).
 */
export function analyticsEngineExporter(binding: AnalyticsEngineLike, dataset?: string): SpanExporter {
  return {
    async export(spans) {
      for (const span of spans) {
        const route = span.attributes['route.id'] ?? span.attributes['http.route'];
        binding.writeDataPoint({
          indexes: [span.traceId],
          blobs: [
            span.name,
            span.spanId,
            span.parentSpanId ?? '',
            span.status,
            typeof route === 'string' ? route : '',
            ...(dataset ? [dataset] : []),
          ],
          doubles: [span.duration(), span.start],
        });
      }
    },
  };
}

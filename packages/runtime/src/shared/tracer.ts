import { type Capabilities, type HypDrivEnv, type ResolvedConfig, readEnv } from '@hypdriv/core';
import {
  analyticsEngineExporter,
  consoleExporter,
  createTracer,
  noopExporter,
  otlpHttpExporter,
  type SpanExporter,
  type Tracer,
} from '@hypdriv/observe';

/** Parses `key=value,key2=value2` (the OTEL_EXPORTER_OTLP_HEADERS format). */
function parseHeaderList(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, ...rest] = pair.split('=');
    if (k?.trim() && rest.length) out[k.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

/**
 * Builds the tracer described by `observe.tracing` (OTLP/HTTP with headers from `headersEnv`, console,
 * Analytics Engine when the binding exists); null when tracing is off. Lives outside the stage graph so
 * `instrumentation.ts` (which Next.js also compiles for the Edge runtime) stays small.
 */
export function createConfiguredTracer(
  config: ResolvedConfig,
  env: HypDrivEnv,
  caps: Pick<Capabilities, 'analyticsEngine'>,
): Tracer | null {
  const t = config.observe.tracing;
  if (!t || t.exporter === 'none') return null;
  let exporter: SpanExporter;
  if (t.exporter === 'otlp' && t.otlp) {
    const fromEnv = t.otlp.headersEnv
      ? readEnv(env as Record<string, unknown>, t.otlp.headersEnv)
      : undefined;
    exporter = otlpHttpExporter({
      url: t.otlp.url,
      headers: { ...t.otlp.headers, ...(fromEnv ? parseHeaderList(fromEnv) : {}) },
      timeoutMs: t.otlp.timeoutMs,
    });
  } else if (t.exporter === 'analytics-engine' && caps.analyticsEngine) {
    exporter = analyticsEngineExporter(env[t.analyticsEngineBinding] as never);
  } else if (t.exporter === 'console') {
    exporter = consoleExporter();
  } else {
    // `otlp` without an endpoint or `analytics-engine` without the binding: spans are dropped.
    exporter = noopExporter();
  }
  return createTracer({ serviceName: t.serviceName, exporter, sampleRate: t.sampleRate });
}

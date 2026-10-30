export {
  type NextErrorContext,
  type NextErrorRequest,
  type NextOnRequestError,
  type OnRequestErrorOptions,
  onRequestError,
  type RequestErrorEvent,
} from './errors';
export { type CreateLoggerOptions, createLogger, redact, redactHeaders } from './logger';
export { serverTimingMode } from './server-timing';
export {
  flushAfterRootSpan,
  type ObserveStageOptions,
  observeStage,
  VITALS_SINK_KEY,
} from './stages/observe';
export { requestIdStage } from './stages/request-id';
export { cacheStatusOf, maskIp, ROOT_SPAN_KEY, TRACE_KEY } from './stages/shared';
export {
  analyticsEngineExporter,
  type ConsoleExporterOptions,
  consoleExporter,
  noopExporter,
  type OtlpAnyValue,
  type OtlpHttpExporterOptions,
  type OtlpKeyValue,
  type OtlpSpan,
  type OtlpTracePayload,
  otlpAttributes,
  otlpHttpExporter,
  otlpTracesUrl,
  otlpValue,
  toOtlpPayload,
  toUnixNano,
} from './trace/exporters';
export type { Attributes, AttributeValue, Span, SpanEvent, SpanKind, SpanStatus } from './trace/span';
export {
  createTracer,
  formatTraceparent,
  parseTraceparent,
  type SpanExporter,
  type StartSpanOptions,
  sampleTrace,
  type TraceContext,
  type Tracer,
  type TracerOptions,
} from './trace/tracer';
export {
  normalizeVitalsPayload,
  rateVital,
  VITALS_THRESHOLDS,
  type VitalsHandlerOptions,
  vitalsHandler,
} from './vitals/handler';
export {
  analyticsEngineVitalsSink,
  functionVitalsSink,
  logVitalsSink,
  multiVitalsSink,
} from './vitals/sinks';
export type { VitalName, VitalRating, VitalsContext, VitalsPayload, VitalsSink } from './vitals/types';

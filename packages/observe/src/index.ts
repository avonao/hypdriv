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
  renderVitalsDashboard,
  type VitalsDashboardOptions,
  type VitalsDashboardView,
} from './vitals/dashboard';
export {
  buildExperimentReport,
  chiSquareSurvival,
  type ExperimentDescription,
  type ExperimentMetricResult,
  type ExperimentReport,
  type ExperimentRows,
  type ExperimentVariantResult,
  experimentExposuresSql,
  experimentVitalsSql,
  type SampleRatioCheck,
  sampleRatioCheck,
} from './vitals/experiments';
export {
  normalizeVitalsPayload,
  rateVital,
  VITALS_THRESHOLDS,
  type VitalsHandlerOptions,
  vitalsHandler,
} from './vitals/handler';
export { type MemoryVitals, type MemoryVitalsOptions, memoryVitals } from './vitals/memory';
export {
  AnalyticsEngineQueryError,
  type AnalyticsEngineQueryOptions,
  type AnalyticsEngineVitalsSourceOptions,
  analyticsEngineVitalsSource,
  type CachedVitalsSourceOptions,
  cachedVitalsSource,
  queryAnalyticsEngine,
  type VitalsSqlOptions,
  vitalsDistributionSql,
  vitalsOverallSql,
  vitalsSql,
  vitalsTrendSql,
} from './vitals/query';
export {
  analyticsEngineVitalsSink,
  functionVitalsSink,
  logVitalsSink,
  multiVitalsSink,
} from './vitals/sinks';
export {
  buildVitalsSnapshot,
  formatVital,
  parseBucketTime,
  type SnapshotMeta,
  trendBucketSeconds,
  VITAL_LABELS,
  VITAL_NAMES,
  type VitalsRows,
  weightedQuantile,
} from './vitals/stats';
export type {
  VitalName,
  VitalRating,
  VitalStat,
  VitalsContext,
  VitalsDistribution,
  VitalsOverall,
  VitalsPayload,
  VitalsQuery,
  VitalsRouteSummary,
  VitalsSink,
  VitalsSnapshot,
  VitalsSource,
  VitalsSourceKind,
  VitalsTrendPoint,
} from './vitals/types';

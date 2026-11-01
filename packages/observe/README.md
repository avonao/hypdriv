# @hypdriv/observe

Observability for Hypdriv applications: a dependency-free span model with W3C `traceparent` propagation and console / OTLP-HTTP / Analytics Engine exporters, a structured logger with redaction and sampling, the `request-id` and `observe` Drivetrain stages (ids, `Server-Timing`, request summary lines), the Web Vitals beacon endpoint with log and Analytics Engine sinks, Next's `onRequestError` hook, and a tiny browser entry (`@hypdriv/observe/client`) that reports vitals with route, build and cache attribution.

Runtime-neutral: no Node built-ins, no Cloudflare types, no OpenTelemetry SDK.

## Install

```sh
pnpm add @hypdriv/observe @hypdriv/core
```

## Tracing

```ts
import { createTracer, otlpHttpExporter, consoleExporter, analyticsEngineExporter, noopExporter } from '@hypdriv/observe';

const tracer = createTracer({
  serviceName: 'shop',
  exporter: otlpHttpExporter({ url: 'https://api.honeycomb.io', headers: { 'x-honeycomb-team': env.HONEYCOMB_KEY } }),
  sampleRate: 0.2,
  resource: { 'deployment.environment': 'production' },
});

const span = tracer.startSpan('checkout.total', { parent: request.headers.get('traceparent'), kind: 'server' });
await tracer.withSpan('db.query', async (child) => { child.setAttribute('db.rows', 3); /* ... */ }, { parent: span });
span.end();
ctx.waitUntil(tracer.flush());
```

- `Span`: `traceId`, `spanId`, `parentSpanId`, `name`, `kind`, `start`/`endTime` (epoch ms), `attributes`, `events`, `status` (`unset | ok | error`), `setAttribute`, `addEvent`, `setStatus`, `recordException`, `end()`, `duration()`, `onEnd()`. The contract lists `end` both as the timestamp and as the method; here `end()` ends the span and `endTime` is the timestamp.
- Sampling: a new trace is sampled deterministically from its trace id (`sampleRate`); spans with a parent (object or `traceparent`) inherit the parent's flag. Unsampled spans are cheap and never exported.
- `withSpan` records exceptions as an `exception` event (`exception.type`, `exception.message`, `exception.stacktrace`) with status `error`, then rethrows.
- `flush()` sends every ended, sampled span buffered so far in one batch and never throws. `parseTraceparent` / `formatTraceparent` handle the header format.

| Exporter                            | Output                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `consoleExporter({ sink? })`        | one compact JSON line per span (`type: 'span'`, ids, name, kind, ISO start, `durationMs`, status, attributes, events) for Workers Logs            |
| `otlpHttpExporter({ url, headers?, timeoutMs?, fetch?, batchSize? })` | OTLP/HTTP JSON `POST <url>/v1/traces` (`resourceSpans → scopeSpans → spans`, hex ids, nanosecond timestamps as strings, `{ key, value: { stringValue \| intValue \| doubleValue \| boolValue } }` attributes, status codes 0/1/2). Network and collector errors are swallowed and logged at most once per minute |
| `analyticsEngineExporter(binding)`  | one data point per span: indexes `[traceId]`, blobs `[name, spanId, parentSpanId, status, route]`, doubles `[durationMs, start]`                 |
| `noopExporter()`                    | drops everything                                                                                                                                 |

## Logging

```ts
import { createLogger, redact, redactHeaders } from '@hypdriv/observe';
const log = createLogger(config.observe.logging, { service: 'shop' });
log.info('order placed', { orderId, email }); // `email` redacted when listed in observe.logging.redact
```

`createLogger(config.observe.logging, fields?, options?)` emits the same JSON (or pretty) lines as core's console logger, redacts secret-looking keys (`password`, `token`, `authorization`, `cookie`, …) plus `logging.redact`, and samples `debug`/`info` lines by `logging.sampleRate`. Sampling is decided once per request id (`requestId` bound field, `traceId` as fallback) so a request's lines stay together; `warn`/`error` are never sampled. Correlation ids (`requestId`, `traceId`, `spanId`, `parentSpanId`) are exempt from value redaction. `redact(fields, extraKeys?)` and `redactHeaders(headers, extraNames?)` are the helpers AGENTS.md refers to.

## Stages

```ts
import { requestIdStage, observeStage, TRACE_KEY, ROOT_SPAN_KEY } from '@hypdriv/observe';
const stages = [requestIdStage(config, tracer), /* …security, cache, headers… */ observeStage(config, { tracer })];
```

| Stage        | pre                                                                                                                                    | post                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `request-id` | continues the incoming `traceparent` (or starts a trace), starts the `http.request` server span (`http.method`, `http.target`, `http.host`, `http.scheme`, `hypdriv.request_id`, `hypdriv.runner`), sets `TRACE_KEY` and `ROOT_SPAN_KEY`, binds `requestId`/`traceId` to `ctx.log`, forwards `x-hypdriv-request-id` and `traceparent` to Next.js | sets `x-request-id` (unless the app set one), `x-hypdriv-request-id`, `Server-Timing` per `serverTimingMode()`; ends the span with `http.status_code`, `route.id`, `http.route`, `hypdriv.cache` (from `x-hypdriv-cache` or the `cache` Server-Timing marker) and status `ok`/`error` (5xx) |
| `observe`    | exposes `VITALS_SINK_KEY`                                                                                                              | request summary line (`method`, `path`, `status`, `duration`, `route`, `cache`, `bot`, masked `ip`, `runner`) when `logging.requests`; schedules `tracer.flush()` in `waitUntil` once the root span has ended |

Both stages run on internal paths (`/_next/*`, `/_hypdriv/*`). `serverTimingMode(config, development)` resolves `observe.serverTiming`: `auto` → `verbose` in development, `compact` otherwise; `off` disables the header (ADR 0008). The cache status never requires importing `@hypdriv/cache`: it is read from the response header or from the `cache;desc=<status>` timing marker the cache stage always records.

## Web Vitals

Server side:

```ts
import { vitalsHandler, logVitalsSink, analyticsEngineVitalsSink, multiVitalsSink } from '@hypdriv/observe';
const handleVitals = vitalsHandler({
  sink: env.HYPDRIV_ANALYTICS ? analyticsEngineVitalsSink(env.HYPDRIV_ANALYTICS) : logVitalsSink(log),
  sampleRate: config.observe.vitals?.sampleRate,
  allowOrigin: 'https://app.example.com',
});
// POST /_hypdriv/vitals → 204
```

| Behaviour     | Detail                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| body          | one payload or an array, JSON also as `text/plain` (`navigator.sendBeacon`); `maxBytes` (64 KB) and `maxMetrics` (32) caps → `413`/`400` |
| validation    | `name ∈ LCP/INP/CLS/FCP/TTFB`, finite `value ≥ 0`, `id`, `pathname` starting with `/`; `rating` derived from web.dev thresholds when missing; strings bounded; unknown primitive fields pass through |
| sampling      | `sampleRate` per beacon, so a page view's metrics stay together                                                                         |
| context       | `ip` (`cf-connecting-ip` / `x-forwarded-for`), `country` (`cf-ipcountry`), `ua`, overridable through the second argument                 |
| CORS          | with `allowOrigin` (`*` or a comma-separated list): preflight `204` and `access-control-*` headers                                       |
| response      | `204` with `cache-control: no-store`; `405` for other methods                                                                           |

Reading vitals back: `vitalsSql`, `vitalsOverallSql`, `vitalsTrendSql` and `vitalsDistributionSql` build the Analytics Engine SQL for the layout `analyticsEngineVitalsSink` writes; `queryAnalyticsEngine()` runs it; `analyticsEngineVitalsSource({ accountId, apiToken, dataset })` and `memoryVitals()` are `VitalsSource`s returning a `VitalsSnapshot` (site-wide and per-route p75, rating split, trend); `cachedVitalsSource()` shares and reuses queries; `renderVitalsDashboard()` renders a snapshot as the script-free HTML page behind `/_hypdriv/dash`.

Experiments: when `flags` runs experiments, `vitalsHandler({ experimentCookie })` tags each payload with the visitor's variants (`|checkout:b|`, from the cookie, never from the body) and `analyticsEngineVitalsSink` stores the tag as the eighth blob. `experimentExposuresSql` / `experimentVitalsSql` build the Analytics Engine SQL for exposures per variant and p75 LCP/INP/CLS per variant; `sampleRatioCheck(observed, weights)` is the χ² check of the observed split against the weights, and `buildExperimentReport(description, rows, { days })` assembles the report `hypdriv experiments` prints.

Sinks: `logVitalsSink(log)` (one `vitals` line per metric, no ip), `analyticsEngineVitalsSink(binding)` (indexes `[route]`, blobs `[name, rating, pathname, navigationType, buildId, cache, country, experiments]`, doubles `[value, ts]`), `multiVitalsSink(sinks)`, `functionVitalsSink(fn)`.

Client side (`@hypdriv/observe/client`, 3.5 kB minified, no runtime dependencies):

```ts
import { reportVitals, readServerTiming, readHypDrivHeaders } from '@hypdriv/observe/client';
const stop = reportVitals({ endpoint: '/_hypdriv/vitals', sampleRate: 1, attribution: true });
```

- `reportVitals(options)` loads `web-vitals` (a dependency; `web-vitals/attribution` when `attribution` is on) as a separate chunk and subscribes to LCP, INP, CLS, FCP and TTFB. When the chunk cannot load it falls back to a basic `PerformanceObserver` implementation (TTFB, FCP, LCP, CLS; no INP, no session windows); `source: 'observer'` forces that, and `source: (report) => …` plugs any metric stream in (e.g. `useReportWebVitals(report)` from `next/web-vitals`).
- Payloads carry `route` and `buildId` from `<meta name="hypdriv:route">` / `<meta name="hypdriv:build">`, `cache` from the `cache` Server-Timing entry, `pathname`, `ts`, optional `attribution` and `extra()` fields. They are batched and sent with `navigator.sendBeacon` on `visibilitychange` (hidden) / `pagehide`, else `fetch` with `keepalive`.
- `createVitalsReporter(options)` is the queue + beacon half without a metric source. `readServerTiming()` returns the navigation entry's `Server-Timing` as core `TimingEntry[]`; `readHypDrivHeaders()` returns all `hypdriv:*` meta tags plus the cache status.

## `instrumentation.ts`

```ts
import { onRequestError as hypOnRequestError, createLogger, createTracer, consoleExporter } from '@hypdriv/observe';
const log = createLogger({ level: 'info', format: 'json', redact: [], sampleRate: 1, requests: true });
export const onRequestError = hypOnRequestError({ log, tracer: createTracer({ serviceName: 'shop', exporter: consoleExporter() }) });
```

`onRequestError(options)` matches Next's `(error, request, context)` signature: it logs the error with redacted headers (`cookie`, `authorization`, … and `redactKeys`), records it as an `exception` event on a `next.request-error` span parented to the request's `traceparent` (forwarded by the `request-id` stage, so the error lands in the request's trace), forwards a normalised `RequestErrorEvent` to `sink`, and never throws.

## Workers vs Node

| Topic               | Workers                                                                 | Node / `next dev`                                        |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| span export         | `ctx.waitUntil` keeps the isolate alive for the flush                   | core's context collects promises; `flushContext` in tests |
| console exporter    | lines are ingested by Workers Logs                                      | stdout                                                   |
| Analytics Engine    | available through the binding                                           | use the log sinks/exporters                              |
| clocks              | `performance.timeOrigin + performance.now()` (coarse inside a request)  | high resolution                                          |
| client entry        | —                                                                       | browser only; guards `window`/`document`                 |

## Testing

`pnpm -F @hypdriv/observe test` covers the tracer and `traceparent`, the exact OTLP JSON payload, console and Analytics Engine exporters, logger redaction and sampling, both stages through core's `runPipeline`, the vitals handler and sinks, `onRequestError`, and the client entry against a mocked `performance`/DOM.

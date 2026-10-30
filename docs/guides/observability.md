# Observability

## Server-Timing

Every stage records its duration and outcome. In development and `wrangler dev` the header is verbose; in production it is compact (`cache`, `csp`, `next`, `limit`, `bot`, `flags`, `total`) unless `observe.serverTiming: 'verbose'`.

```
Server-Timing: cache;dur=0.42;desc="HIT", csp;desc="hash", next;dur=0, total;dur=1.8
```

Browsers expose these entries through `PerformanceNavigationTiming.serverTiming`; the DevTools HUD renders them (ADR 0008). Never put secrets in stage descriptions — they are visible to users.

## Tracing

```ts
observe: {
  tracing: {
    exporter: 'otlp',
    serviceName: 'shop',
    sampleRate: 0.2,
    otlp: { url: 'https://api.honeycomb.io/v1/traces', headersEnv: 'OTLP_HEADERS' }, // OTLP_HEADERS="x-honeycomb-team=…"
  },
}
```

Each request gets a root span `http.request` (method, path, route id, status, cache status); `traceparent` is accepted from upstream and forwarded to Next.js and to `hypFetch` calls. Exporters: `console` (one JSON line per span, picked up by Workers Logs), `otlp` (OTLP/HTTP JSON, batched, exported in `waitUntil`), `analytics-engine` (`HYPDRIV_ANALYTICS`), `none`. Add your own spans:

```ts
import { hyp } from '@hypdriv/next/server';
const { pipeline } = await hyp();
```

Inside the Worker `pipeline` is the full context; `@hypdriv/observe` exposes `createTracer()`/`withSpan()` for custom instrumentation anywhere.

## Logging

`createLogger()` emits JSON lines with request-scoped fields (`requestId`, `traceId`, `route`), redacts secret-looking keys and values (`password`, `token`, `authorization`, `cookie`, long opaque strings) plus the keys you list in `observe.logging.redact`, and samples `info`/`debug` lines with `sampleRate`. Workers Logs captures stdout/stderr; enable `observability.enabled` in `wrangler.jsonc`.

The request summary line (`observe.logging.requests`) contains method, path, status, duration, route, cache status and bot verdict.

## Web Vitals

```tsx
// app/layout.tsx
import { VitalsReporter } from '@hypdriv/next/client';
<VitalsReporter />   // beacons LCP, INP, CLS, FCP, TTFB to /_hypdriv/vitals
```

Payloads include the route id, build id, navigation type, the `cache` status read from `Server-Timing`, and attribution (LCP element, INP target, CLS sources) when `web-vitals` is installed (`pnpm add web-vitals`; otherwise a `PerformanceObserver` fallback reports LCP/CLS/FCP/TTFB). Sinks: logs (default) or Analytics Engine. With Analytics Engine:

```sh
CF_ACCOUNT_ID=… CF_API_TOKEN=… npx hypdriv vitals --days 7      # p75 per route and metric
```

## Errors

`instrumentation.ts`:

```ts
import { createInstrumentation } from '@hypdriv/next/instrumentation';
export const { register, onRequestError } = createInstrumentation();
```

`onRequestError` logs with redaction, attaches the trace id and forwards to the configured sink (`observe.errors.sink`). In the Worker, unhandled errors in stages are logged and the stage is skipped; errors from Next.js propagate to the `onError` hook of `createWorker` (default: a plain 500 with the request id).

## DevTools HUD

`<HypDrivDevTools />` (from `@hypdriv/next/client`) renders a floating panel in development and preview. Panels: request stages (from `Server-Timing`), Web Vitals, navigations (RSC fetches), flags, Purser diagnostics (from the bridge's dev endpoint), build info, capabilities. Toggle with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>. Nothing is injected into production HTML unless you pass `force`.

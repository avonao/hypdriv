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
import { hyp } from 'hypdriv/server';
const { pipeline } = await hyp();
```

Inside the Worker `pipeline` is the full context; `@hypdriv/observe` exposes `createTracer()`/`withSpan()` for custom instrumentation anywhere.

## Logging

`createLogger()` emits JSON lines with request-scoped fields (`requestId`, `traceId`, `route`), redacts secret-looking keys and values (`password`, `token`, `authorization`, `cookie`, long opaque strings) plus the keys you list in `observe.logging.redact`, and samples `info`/`debug` lines with `sampleRate`. Workers Logs captures stdout/stderr; enable `observability.enabled` in `wrangler.jsonc`.

The request summary line (`observe.logging.requests`) contains method, path, status, duration, route, cache status and bot verdict.

## Web Vitals

```tsx
// app/layout.tsx
import { VitalsReporter } from 'hypdriv/client';
<VitalsReporter />   // beacons LCP, INP, CLS, FCP, TTFB to /_hypdriv/vitals
```

Payloads include the route id, build id, navigation type, the `cache` status read from `Server-Timing`, and attribution (LCP element, INP target, CLS sources) from `web-vitals` (loaded as a separate chunk; if it cannot load, a `PerformanceObserver` fallback reports LCP/CLS/FCP/TTFB). Sinks: logs (default) or Analytics Engine. With Analytics Engine:

```sh
CF_ACCOUNT_ID=… CF_API_TOKEN=… npx hypdriv vitals --days 7      # p75 per route and metric
CF_ACCOUNT_ID=… CF_API_TOKEN=… npx hypdriv vitals --trend        # p75 over time (hourly, 6-hourly or daily)
```

### Dashboard

`/_hypdriv/dash` is a server-rendered page with the site-wide p75 of every metric, the share of good / needs-improvement / poor measurements, a trend line per metric with the good and poor limits marked, and a table of p75 per route. Turn it on and set an access token:

```ts
// hypdriv.config.ts
export default defineConfig({
  observe: { vitals: { sink: 'analytics-engine', dashboard: true } },
});
```

```sh
openssl rand -base64 32 | npx wrangler secret put HYPDRIV_DASH_TOKEN
```

Open `https://example.com/_hypdriv/dash?token=<token>` once. The response redirects without the token in the address and sets a signed session cookie (`HttpOnly`, `SameSite=Strict`, bound to the host, valid for `sessionMinutes`, 8 hours by default); rotating the token signs everyone out. Scripts use `Authorization: Bearer <token>` and `?format=json` (or `Accept: application/json`). Without the token the route answers `404`, like `/_hypdriv/purge`; a token shorter than 24 characters keeps it hidden. `?days=1..90` and `?route=<id or pathname>` narrow the view.

Where the numbers come from:

| Data source | When | Covers |
| --- | --- | --- |
| Workers Analytics Engine, through its SQL API | `HYPDRIV_ANALYTICS_ACCOUNT_ID`, `HYPDRIV_ANALYTICS_API_TOKEN` (Account Analytics: Read) and the dataset (`dashboard.dataset` or `HYPDRIV_ANALYTICS_DATASET`) are set, and `sink: 'analytics-engine'` | all traffic, all instances; snapshots are reused for `cacheSeconds` (60) and concurrent viewers share one query |
| Recent measurements in memory | anything is missing, or on Vercel and Node | the traffic of one server instance (`memoryCapacity` measurements, 5000 by default); the page labels it as partial data. Exact on a single long-lived Node process, a sample on Workers and Vercel |
| Your own `VitalsSource` | `createHandler({ platform: { vitalsSource } })` in a custom host | whatever you query (Prometheus, a warehouse, a vendor API) |

The page runs no script, has its own strict `Content-Security-Policy` (one `<style>` carrying a per-request nonce), is never cached (`private, no-store`) and is marked `noindex`; the API token never reaches the page or the logs, and a failing query shows a `502` page with the reason (for example a token without the right permission). `hypdriv doctor` checks the token, the secrets and the sink, and `hypdriv vitals --trend` prints the same trend in the terminal.

### Experiments

When edge experiments run (`flags.definitions.<name>.experiment`, see [Flags](flags.md#experiments-ab-tests)), the vitals beacon route tags each measurement with the visitor's variants, read from the first-party experiment cookie — never from the beacon body, so a forged tag is ignored. The Analytics Engine sink stores the tag as the eighth blob (`|checkout:one_page|hero:control|`, empty outside experiments), so a variant's vitals are one `position('|checkout:one_page|' IN blob8) > 0` away. Exposures share the dataset:

| Row | `blob1` | Other blobs | Doubles |
| --- | --- | --- | --- |
| Web Vital | `LCP`, `INP`, `CLS`, `FCP`, `TTFB` | rating, pathname, navigation type, build id, cache, country, experiment tag | value, timestamp |
| Exposure | `experiment.exposure` | experiment, variant, pathname, route, country, build id | timestamp |

`hypdriv experiments --results` runs both queries; `hypdriv vitals` is unaffected (its queries select vitals by `blob1`).

## Errors

`instrumentation.ts`:

```ts
import { createInstrumentation } from 'hypdriv/instrumentation';
export const { register, onRequestError } = createInstrumentation();
```

`onRequestError` logs with redaction, attaches the trace id and forwards to the configured sink (`observe.errors.sink`). In the Worker, unhandled errors in stages are logged and the stage is skipped; errors from Next.js propagate to the `onError` hook of `createWorker` (default: a plain 500 with the request id).

## DevTools HUD

`<HypDrivDevTools />` (from `hypdriv/client`) renders a floating panel in development and preview. Panels: request stages (from `Server-Timing`), Web Vitals, navigations (RSC fetches), flags, Purser diagnostics (from the bridge's dev endpoint), build info, capabilities. Toggle with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>. Nothing is injected into production HTML unless you pass `force`.

## Tail Workers

`createWorker()` exports a `tail` handler, so any Hypdriv Worker can be the tail consumer of others (`"tail_consumers": [{ "service": "<this worker>" }]` in the producer's wrangler config). It logs the producer's exceptions (`tail exception`), `console.warn`/`console.error` lines (`tail log`) and invocations that ended abnormally without an exception — CPU, memory or wall-time limits, cancellations — as `tail outcome` with the script name and the path, cron or queue. The last kind leaves no trace in the producer's own logs.

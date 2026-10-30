/**
 * Browser-only helpers: Web Vitals reporting to `/_hypdriv/vitals` and reading HypDriv's
 * `Server-Timing` / `<meta name="hypdriv:*">` attribution. No Node APIs, no runtime dependencies;
 * `web-vitals` is loaded dynamically when installed.
 */
import type { TimingEntry } from '@hypdriv/core';

export type ClientVitalName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
export type ClientVitalRating = 'good' | 'needs-improvement' | 'poor';

/** The shape `web-vitals` (and Next's `useReportWebVitals`) hand to callbacks. */
export interface VitalMetricLike {
  name: ClientVitalName | string;
  value: number;
  rating?: ClientVitalRating;
  id: string;
  delta?: number;
  navigationType?: string;
  attribution?: Record<string, unknown>;
}

export interface ClientVitalsPayload {
  name: ClientVitalName;
  value: number;
  rating: ClientVitalRating;
  id: string;
  delta?: number;
  navigationType?: string;
  attribution?: Record<string, unknown>;
  route?: string;
  buildId?: string;
  cache?: string;
  pathname: string;
  ts: number;
  [extra: string]: unknown;
}

export interface VitalsReporterOptions {
  /** Beacon endpoint (default `/_hypdriv/vitals`). */
  endpoint?: string;
  /** Share of page loads that report, 0..1 (default 1). */
  sampleRate?: number;
  /** Include `web-vitals` attribution data (default true). */
  attribution?: boolean;
  /** Extra fields merged into every payload. */
  extra?: () => Record<string, unknown>;
}

export interface ReportVitalsOptions extends VitalsReporterOptions {
  /**
   * Metric source. Default: `web-vitals` (`/attribution` build when `attribution` is on) loaded with a
   * dynamic import, falling back to a basic `PerformanceObserver` implementation when that fails.
   * `'observer'` forces the fallback; a function receives the reporter's `report` callback (for
   * `useReportWebVitals`) and returns an optional cleanup.
   */
  source?: 'auto' | 'observer' | ((report: (metric: VitalMetricLike) => void) => void | (() => void));
}

export interface VitalsReporter {
  /** Queues a metric (from `web-vitals` or `next/web-vitals`). */
  report(metric: VitalMetricLike): void;
  /** Sends queued metrics now (`sendBeacon`, else `fetch` with `keepalive`). */
  flush(): void;
  /** Flushes and detaches listeners. */
  stop(): void;
}

const NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];
const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

function rate(name: string, value: number): ClientVitalRating {
  const t = THRESHOLDS[name];
  if (!t || value <= t[0]) return 'good';
  return value <= t[1] ? 'needs-improvement' : 'poor';
}

/** Reads the navigation entry's `Server-Timing` into core's `TimingEntry[]` (ADR 0008). */
export function readServerTiming(): TimingEntry[] {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | (PerformanceEntry & {
          serverTiming?: ReadonlyArray<{ name: string; duration: number; description: string }>;
        })
      | undefined;
    return (nav?.serverTiming ?? []).map((e) => ({
      name: e.name,
      ...(e.duration > 0 ? { dur: e.duration } : {}),
      ...(e.description ? { desc: e.description } : {}),
    }));
  } catch {
    return [];
  }
}

export interface HypDrivPageInfo {
  route?: string;
  build?: string;
  cache?: string;
  requestId?: string;
  csp?: string;
  [name: string]: string | undefined;
}

/** Reads `<meta name="hypdriv:*">` tags (route, build, requestId, csp...) plus the `cache` Server-Timing entry. */
export function readHypDrivHeaders(): HypDrivPageInfo {
  const out: HypDrivPageInfo = {};
  if (hasDom()) {
    for (const el of Array.from(document.querySelectorAll('meta[name^="hypdriv:"]'))) {
      const name = el.getAttribute('name')?.slice(8);
      const content = el.getAttribute('content');
      if (name && content) out[name] = content;
    }
  }
  if (!out.cache) {
    const cache = readServerTiming().find((e) => e.name === 'cache')?.desc;
    if (cache) out.cache = cache;
  }
  return out;
}

/** Creates the queue + beacon half of the reporter; feed it from any metric source. */
export function createVitalsReporter(options: VitalsReporterOptions = {}): VitalsReporter {
  const noop: VitalsReporter = { report() {}, flush() {}, stop() {} };
  if (!hasDom()) return noop;
  const sampleRate = options.sampleRate ?? 1;
  if (sampleRate < 1 && Math.random() >= sampleRate) return noop;
  const endpoint = options.endpoint ?? '/_hypdriv/vitals';
  const withAttribution = options.attribution ?? true;
  const queue: ClientVitalsPayload[] = [];
  let info: HypDrivPageInfo | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!queue.length) return;
    const body = JSON.stringify(queue.splice(0, queue.length));
    try {
      if (navigator.sendBeacon?.(endpoint, body)) return;
    } catch {
      // fall through to fetch
    }
    fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'content-type': 'text/plain' },
    }).catch(() => undefined);
  };

  const report = (m: VitalMetricLike) => {
    if (stopped || !m || !NAMES.includes(m.name) || typeof m.value !== 'number') return;
    info ??= readHypDrivHeaders();
    const payload: ClientVitalsPayload = {
      name: m.name as ClientVitalName,
      value: m.value,
      rating: m.rating ?? rate(m.name, m.value),
      id: m.id,
      pathname: location.pathname,
      ts: Date.now(),
    };
    if (typeof m.delta === 'number') payload.delta = m.delta;
    if (m.navigationType) payload.navigationType = m.navigationType;
    if (withAttribution && m.attribution) payload.attribution = m.attribution;
    if (info.route) payload.route = info.route;
    if (info.build) payload.buildId = info.build;
    if (info.cache) payload.cache = info.cache;
    if (options.extra) Object.assign(payload, options.extra());
    queue.push(payload);
    // Metrics reported while hidden (web-vitals finalises LCP/CLS/INP then) must leave immediately.
    if (document.visibilityState === 'hidden') flush();
    else timer ??= setTimeout(flush, 3000);
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  addEventListener('visibilitychange', onVisibility, true);
  addEventListener('pagehide', flush, true);

  return {
    report,
    flush,
    stop() {
      stopped = true;
      removeEventListener('visibilitychange', onVisibility, true);
      removeEventListener('pagehide', flush, true);
      flush();
    },
  };
}

type WebVitalsModule = Record<
  'onLCP' | 'onINP' | 'onCLS' | 'onFCP' | 'onTTFB',
  (cb: (m: VitalMetricLike) => void) => void
>;

async function loadWebVitals(attribution: boolean): Promise<WebVitalsModule> {
  const mod = (attribution ? await import('web-vitals/attribution') : await import('web-vitals')) as unknown;
  return mod as WebVitalsModule;
}

/** Basic LCP/CLS/FCP/TTFB via `PerformanceObserver` when `web-vitals` is unavailable (no INP, no session windows). */
function observerSource(report: (metric: VitalMetricLike) => void): () => void {
  const observers: PerformanceObserver[] = [];
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const navigationType = nav?.type;
  const id = () => `v-${Date.now()}-${Math.floor(Math.random() * 1e12)}`;
  const emit = (name: ClientVitalName, value: number) => report({ name, value, id: id(), navigationType });
  const observe = (type: string, cb: (entries: PerformanceEntryList) => void) => {
    try {
      const po = new PerformanceObserver((list) => cb(list.getEntries()));
      po.observe({ type, buffered: true });
      observers.push(po);
    } catch {
      // entry type unsupported
    }
  };
  if (nav && nav.responseStart > 0) emit('TTFB', Math.max(0, nav.responseStart - (nav.activationStart ?? 0)));
  let fcpDone = false;
  observe('paint', (entries) => {
    for (const e of entries) {
      if (e.name === 'first-contentful-paint' && !fcpDone) {
        fcpDone = true;
        emit('FCP', e.startTime);
      }
    }
  });
  let lcp: number | undefined;
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });
  let cls = 0;
  observe('layout-shift', (entries) => {
    for (const e of entries as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
      if (!e.hadRecentInput) cls += e.value ?? 0;
    }
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (lcp !== undefined) emit('LCP', lcp);
    emit('CLS', cls);
    for (const o of observers) o.disconnect();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') finish();
  };
  addEventListener('visibilitychange', onVisibility, true);
  addEventListener('pagehide', finish, true);
  return () => {
    removeEventListener('visibilitychange', onVisibility, true);
    removeEventListener('pagehide', finish, true);
    finish();
  };
}

/**
 * Starts Web Vitals reporting for the page and returns a stop function. Uses `web-vitals` when it can
 * be loaded (install it as a dependency; bundlers need to resolve the import), otherwise a basic
 * `PerformanceObserver` fallback. Payloads carry `route`/`buildId` from `<meta name="hypdriv:route|build">`
 * and `cache` from the `cache` Server-Timing entry; the server side is `vitalsHandler`.
 */
export function reportVitals(options: ReportVitalsOptions = {}): () => void {
  if (!hasDom()) return () => {};
  const reporter = createVitalsReporter(options);
  let cleanup: (() => void) | void;
  let stopped = false;
  const source = options.source ?? 'auto';
  if (typeof source === 'function') cleanup = source(reporter.report);
  else if (source === 'observer') cleanup = observerSource(reporter.report);
  else {
    loadWebVitals(options.attribution ?? true)
      .then((wv) => {
        if (stopped) return;
        wv.onTTFB(reporter.report);
        wv.onFCP(reporter.report);
        wv.onLCP(reporter.report);
        wv.onCLS(reporter.report);
        wv.onINP(reporter.report);
      })
      .catch(() => {
        if (!stopped) cleanup = observerSource(reporter.report);
      });
  }
  return () => {
    stopped = true;
    cleanup?.();
    reporter.stop();
  };
}

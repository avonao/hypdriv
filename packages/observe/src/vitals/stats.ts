import { rateVital } from './handler';
import type {
  VitalName,
  VitalRating,
  VitalStat,
  VitalsDistribution,
  VitalsOverall,
  VitalsRouteSummary,
  VitalsSnapshot,
  VitalsSourceKind,
  VitalsTrendPoint,
} from './types';

/** The metrics the vitals sinks record, in display order. */
export const VITAL_NAMES: readonly VitalName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

export const VITAL_LABELS: Record<VitalName, string> = {
  LCP: 'Largest Contentful Paint',
  INP: 'Interaction to Next Paint',
  CLS: 'Cumulative Layout Shift',
  FCP: 'First Contentful Paint',
  TTFB: 'Time to First Byte',
};

const isVitalName = (value: string): value is VitalName => (VITAL_NAMES as readonly string[]).includes(value);

/** Formats a metric value: milliseconds (seconds from one second up) for timings, three decimals for CLS. */
export function formatVital(name: VitalName, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (name === 'CLS') return value.toFixed(value >= 1 ? 2 : 3);
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`;
  return `${Math.round(value)} ms`;
}

/** Weighted quantile: the smallest value whose cumulative weight reaches `q` of the total. */
export function weightedQuantile(
  samples: ReadonlyArray<{ value: number; weight: number }>,
  q: number,
): number {
  const usable = samples.filter((s) => Number.isFinite(s.value) && s.weight > 0);
  if (usable.length === 0) return Number.NaN;
  const sorted = [...usable].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  const target = q * total;
  let cumulative = 0;
  for (const s of sorted) {
    cumulative += s.weight;
    if (cumulative >= target) return s.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/** Aggregates as the SQL queries (or the in-memory buffer) produce them, before they become a snapshot. */
export interface VitalsRows {
  overall: Array<{ metric: string; p75: unknown; p50: unknown; samples: unknown }>;
  routes: Array<{ route: unknown; metric: string; p75: unknown; p50: unknown; samples: unknown }>;
  trend: Array<{ bucket: unknown; metric: string; p75: unknown; samples: unknown }>;
  distribution: Array<{ metric: string; rating: string; samples: unknown }>;
}

export interface SnapshotMeta {
  source: VitalsSnapshot['source'];
  days: number;
  route?: string | null;
  now: number;
  bucketSeconds: number;
  /** Routes kept in the table, by sample count (default 50). */
  maxRoutes?: number;
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return n;
};

/** Parses the `timestamp` Analytics Engine returns (`2026-10-31 06:00:00`, UTC) or an epoch in seconds / ms. */
export function parseBucketTime(value: unknown): number {
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  if (typeof value !== 'string') return Number.NaN;
  if (/^\d+(\.\d+)?$/.test(value)) return parseBucketTime(Number(value));
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(iso);
}

function stat(name: VitalName, p75: number, p50: number, samples: number): VitalStat {
  return { p75, p50, samples, rating: rateVital(name, p75) };
}

/** Turns aggregate rows into the snapshot the dashboard renders. Rows with unusable numbers are dropped. */
export function buildVitalsSnapshot(rows: VitalsRows, meta: SnapshotMeta): VitalsSnapshot {
  const distribution = new Map<VitalName, VitalsDistribution>();
  for (const row of rows.distribution) {
    if (!isVitalName(row.metric)) continue;
    const samples = num(row.samples);
    if (!Number.isFinite(samples) || samples <= 0) continue;
    const rating = row.rating as VitalRating;
    if (rating !== 'good' && rating !== 'needs-improvement' && rating !== 'poor') continue;
    const entry = distribution.get(row.metric) ?? { good: 0, 'needs-improvement': 0, poor: 0 };
    entry[rating] += samples;
    distribution.set(row.metric, entry);
  }

  const overall: VitalsOverall[] = [];
  for (const name of VITAL_NAMES) {
    const row = rows.overall.find((r) => r.metric === name);
    if (!row) continue;
    const p75 = num(row.p75);
    const p50 = num(row.p50);
    const samples = num(row.samples);
    if (!Number.isFinite(p75) || !Number.isFinite(samples)) continue;
    overall.push({
      name,
      ...stat(name, p75, Number.isFinite(p50) ? p50 : p75, samples),
      distribution: distribution.get(name) ?? { good: 0, 'needs-improvement': 0, poor: 0 },
    });
  }

  const byRoute = new Map<string, VitalsRouteSummary>();
  for (const row of rows.routes) {
    if (!isVitalName(row.metric) || typeof row.route !== 'string' || row.route === '') continue;
    const p75 = num(row.p75);
    const p50 = num(row.p50);
    const samples = num(row.samples);
    if (!Number.isFinite(p75) || !Number.isFinite(samples)) continue;
    const entry = byRoute.get(row.route) ?? { route: row.route, samples: 0, metrics: {} };
    entry.metrics[row.metric] = stat(row.metric, p75, Number.isFinite(p50) ? p50 : p75, samples);
    entry.samples = Math.max(entry.samples, samples);
    byRoute.set(row.route, entry);
  }
  const routes = [...byRoute.values()]
    .sort((a, b) => b.samples - a.samples || a.route.localeCompare(b.route))
    .slice(0, meta.maxRoutes ?? 50);

  const byBucket = new Map<number, VitalsTrendPoint>();
  for (const row of rows.trend) {
    if (!isVitalName(row.metric)) continue;
    const t = parseBucketTime(row.bucket);
    const p75 = num(row.p75);
    const samples = num(row.samples);
    if (!Number.isFinite(t) || !Number.isFinite(p75) || !Number.isFinite(samples)) continue;
    const point = byBucket.get(t) ?? { t, metrics: {} };
    point.metrics[row.metric] = { p75, samples };
    byBucket.set(t, point);
  }
  const trend = [...byBucket.values()].sort((a, b) => a.t - b.t);

  return {
    source: meta.source,
    days: meta.days,
    route: meta.route ?? null,
    generatedAt: meta.now,
    bucketSeconds: meta.bucketSeconds,
    overall,
    routes,
    trend,
  };
}

/** Trend bucket width for a window: hourly up to two days, six hours up to a week, then daily. */
export function trendBucketSeconds(days: number): number {
  if (days <= 2) return 3600;
  if (days <= 7) return 6 * 3600;
  return 86_400;
}

export type { VitalsSourceKind };

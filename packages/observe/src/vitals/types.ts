import type { Logger } from '@hypdriv/core';

export type VitalName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

/** One Web Vitals measurement as beaconed by `@hypdriv/observe/client`. Unknown extra fields pass through. */
export interface VitalsPayload {
  name: VitalName;
  value: number;
  rating: VitalRating;
  id: string;
  /** Hypdriv route id from `<meta name="hypdriv:route">`. */
  route?: string;
  pathname: string;
  navigationType?: string;
  attribution?: Record<string, unknown>;
  buildId?: string;
  /** Edge cache status of the document (from the `cache` Server-Timing entry). */
  cache?: string;
  /** Client timestamp, epoch ms. */
  ts: number;
  [extra: string]: unknown;
}

export interface VitalsContext {
  ip?: string;
  country?: string;
  ua?: string;
}

export interface VitalsSink {
  write(payload: VitalsPayload, ctx: VitalsContext): void | Promise<void>;
}

export type VitalsLogger = Logger;

// ---------------------------------------------------------------------------
// Reading vitals back: the dashboard model
// ---------------------------------------------------------------------------

/** p75 / p50 of one metric over a window, with the (sample-weighted) number of measurements behind them. */
export interface VitalStat {
  p75: number;
  p50: number;
  samples: number;
  rating: VitalRating;
}

/** Weighted share of measurements per rating (counts, not percentages). */
export interface VitalsDistribution {
  good: number;
  'needs-improvement': number;
  poor: number;
}

/** A metric over the whole site (or the filtered route). */
export interface VitalsOverall extends VitalStat {
  name: VitalName;
  distribution: VitalsDistribution;
}

/** p75 per metric for one route. */
export interface VitalsRouteSummary {
  route: string;
  /** Largest sample count among the route's metrics (a page view reports most metrics once). */
  samples: number;
  metrics: Partial<Record<VitalName, VitalStat>>;
}

/** One bucket of the trend line. `t` is the bucket start in epoch milliseconds. */
export interface VitalsTrendPoint {
  t: number;
  metrics: Partial<Record<VitalName, { p75: number; samples: number }>>;
}

export type VitalsSourceKind = 'analytics-engine' | 'memory' | 'custom';

/** Everything the dashboard (and `?format=json`) shows, independent of where the measurements are stored. */
export interface VitalsSnapshot {
  source: {
    kind: VitalsSourceKind;
    /** Human-readable origin, e.g. the Analytics Engine dataset. */
    label: string;
    /** `true` when the data covers only part of the traffic (an in-memory buffer sees one instance). */
    partial: boolean;
  };
  days: number;
  /** Route filter in effect, if any. */
  route: string | null;
  /** Epoch milliseconds. */
  generatedAt: number;
  /** Width of one trend bucket in seconds. */
  bucketSeconds: number;
  overall: VitalsOverall[];
  routes: VitalsRouteSummary[];
  trend: VitalsTrendPoint[];
}

export interface VitalsQuery {
  /** Look-back window in days (1–90). */
  days: number;
  /** Only this route (route id/pattern or pathname). */
  route?: string | null;
  signal?: AbortSignal;
  /** Epoch milliseconds, for tests. */
  now?: number;
}

/** Where the dashboard reads its numbers from. Implement it to chart vitals stored anywhere. */
export interface VitalsSource {
  query(query: VitalsQuery): Promise<VitalsSnapshot>;
}

import { HypDrivError } from '@hypdriv/core';
import { rateVital } from './handler';
import { EXPERIMENT_METRICS } from './stats';
import type { VitalName, VitalRating } from './types';

/**
 * Reading experiments back: how many visitors each variant got (the exposures the `flags` stage writes) and how the
 * Web Vitals of each variant compare. The Analytics Engine layouts are those of `analyticsEngineExposureSink`
 * (`@hypdriv/flags`: blob1 `experiment.exposure`, blob2 experiment, blob3 variant) and `analyticsEngineVitalsSink`
 * (blob8 `|experiment:variant|…|`).
 */

const DATASET_RE = /^[A-Za-z0-9_]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,48}$/;
const EXPOSURE_METRIC = 'experiment.exposure';

function checked(dataset: string, experiment: string): void {
  if (!DATASET_RE.test(dataset))
    throw new HypDrivError('E_VALIDATION', `invalid Analytics Engine dataset name "${dataset}"`);
  if (!TOKEN_RE.test(experiment))
    throw new HypDrivError('E_VALIDATION', `invalid experiment name "${experiment}"`);
}

/** The look-back window in days: 1–90, `14` for anything that is not a finite number (never `INTERVAL 'NaN' DAY`). */
const days = (n: number) => (Number.isFinite(n) ? Math.min(90, Math.max(1, Math.floor(n))) : 14);

/** The window of an experiment query: the last `days` days, or everything since an explicit moment. */
export interface ExperimentWindow {
  days: number;
  /**
   * Start of the window (a `Date`, epoch milliseconds or an ISO timestamp), UTC. Use it after the weights, `traffic` or
   * variants changed: the sample ratio check compares the visitors of the window with the *current* weights, so a
   * window that spans a ramp is not comparable.
   */
  since?: Date | number | string;
}

/** A window start as a `Date`; anything that is not a valid moment is an error (never reaches a query). */
function windowStart(value: Date | number | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new HypDrivError('E_VALIDATION', `invalid window start "${String(value)}"`);
  return date;
}

/** `YYYY-MM-DD HH:MM:SS` (UTC), the literal Analytics Engine's `toDateTime` reads. */
export function sqlTimestamp(value: Date | number | string): string {
  return windowStart(value).toISOString().slice(0, 19).replace('T', ' ');
}

const windowCondition = (window: ExperimentWindow) =>
  window.since === undefined
    ? `timestamp > NOW() - INTERVAL '${days(window.days)}' DAY`
    : `timestamp >= toDateTime('${sqlTimestamp(window.since)}')`;

/** Visitors exposed per experiment and variant (`SUM(_sample_interval)` counts one row per visitor). */
export function experimentExposuresSql(
  dataset: string,
  options: ExperimentWindow & { experiment?: string },
): string {
  if (!DATASET_RE.test(dataset))
    throw new HypDrivError('E_VALIDATION', `invalid Analytics Engine dataset name "${dataset}"`);
  if (options.experiment !== undefined && !TOKEN_RE.test(options.experiment))
    throw new HypDrivError('E_VALIDATION', `invalid experiment name "${options.experiment}"`);
  return [
    'SELECT blob2 AS experiment, blob3 AS variant, SUM(_sample_interval) AS visitors,',
    '  MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen',
    `FROM ${dataset}`,
    `WHERE ${windowCondition(options)} AND blob1 = '${EXPOSURE_METRIC}'${
      options.experiment ? ` AND blob2 = '${options.experiment}'` : ''
    }`,
    'GROUP BY experiment, variant',
    'ORDER BY experiment, variant',
    'LIMIT 1000',
    'FORMAT JSON',
  ].join('\n');
}

/** p75 per metric for the visitors of one variant (their beacons carry `|experiment:variant|` in blob8). */
export function experimentVitalsSql(
  dataset: string,
  options: ExperimentWindow & { experiment: string; variant: string },
): string {
  checked(dataset, options.experiment);
  if (!TOKEN_RE.test(options.variant))
    throw new HypDrivError('E_VALIDATION', `invalid variant name "${options.variant}"`);
  const metrics = EXPERIMENT_METRICS.map((m) => `'${m}'`).join(', ');
  return [
    'SELECT blob1 AS metric,',
    '  quantileWeighted(0.75, double1, _sample_interval) AS p75,',
    '  SUM(_sample_interval) AS samples',
    `FROM ${dataset}`,
    `WHERE ${windowCondition(options)} AND blob1 IN (${metrics})`,
    `  AND position('|${options.experiment}:${options.variant}|' IN blob8) > 0`,
    'GROUP BY metric',
    'FORMAT JSON',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** ln Γ(x) (Lanczos). */
function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const coefficient of c) ser += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

/** Regularised upper incomplete gamma Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    // Series for P(a, x), then Q = 1 - P.
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // Continued fraction for Q(a, x).
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** P(χ² ≥ x) with `df` degrees of freedom. */
export function chiSquareSurvival(x: number, df: number): number {
  if (!(df > 0) || !Number.isFinite(x)) return Number.NaN;
  if (x <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, x / 2)));
}

/** The most visitors an exact test enumerates (one pass over the outcomes); beyond it every expected count is large anyway. */
const EXACT_LIMIT = 5_000_000;

/**
 * Two-sided exact binomial test: the probability, if each of `n` visitors independently landed in the variant with
 * probability `p`, of any outcome at most as likely as `x` (the method of R's `binom.test`). Exact where the χ²
 * approximation is not: a variant that is expected to get only a handful of visitors.
 */
export function binomialTwoSidedP(x: number, n: number, p: number): number {
  if (!(p > 0 && p < 1) || !Number.isInteger(n) || n < 0 || !Number.isInteger(x) || x < 0 || x > n)
    return Number.NaN;
  const logRatio = Math.log(p / (1 - p));
  // ln P(k = 0), then ln P(k + 1) = ln P(k) + ln((n - k) / (k + 1)) + ln(p / (1 - p)).
  const start = n * Math.log1p(-p);
  let log = start;
  for (let k = 0; k < x; k++) log += Math.log((n - k) / (k + 1)) + logRatio;
  const threshold = log + 1e-7;
  let sum = 0;
  log = start;
  for (let k = 0; k <= n; k++) {
    if (log <= threshold) sum += Math.exp(log);
    log += Math.log((n - k) / (k + 1)) + logRatio;
  }
  return Math.min(1, sum);
}

export interface SampleRatioCheck {
  /** `ok`, `mismatch` (the split differs from the weights by more than chance explains) or `insufficient` (too few visitors to tell). */
  status: 'ok' | 'mismatch' | 'insufficient';
  /** The test behind `p`: `chi-square`, or `exact` (binomial) when a variant is expected to get fewer than 5 visitors. */
  method: 'chi-square' | 'exact' | null;
  /** The χ² statistic (`chi-square` only). */
  chiSquare: number | null;
  /** Probability of a split at least this uneven if assignment followed the weights. */
  p: number | null;
}

/**
 * Sample ratio mismatch: tests the observed visitors per variant against the configured weights. A mismatch
 * (p < 0.001) means the assignment or the counting is broken — a redirect that drops one variant, a cache serving
 * one variant to everyone, bots — and the comparison below it cannot be trusted.
 *
 * The test is Pearson's χ² while every expected count is at least 5. Below that the χ² approximation over-flags
 * (95 of 100 visitors against a 99/1 split gives p = 0.00006 by χ², but 0.0034 exactly), so a two-sided exact
 * binomial test decides instead; with more than two variants it is the smallest per-variant p times the number of
 * variants (Bonferroni, conservative).
 *
 * `observed` must come from one stretch of time in which the weights did not change (see `ExperimentWindow.since`).
 */
export function sampleRatioCheck(
  observed: Record<string, number>,
  weights: Record<string, number>,
  options: { threshold?: number; minVisitors?: number } = {},
): SampleRatioCheck {
  const variants = Object.keys(weights).filter((v) => (weights[v] ?? 0) > 0);
  const counts = variants.map((v) => Math.max(0, Math.round(observed[v] ?? 0)));
  const total = counts.reduce((sum, n) => sum + n, 0);
  const weightSum = variants.reduce((sum, v) => sum + (weights[v] ?? 0), 0);
  if (variants.length < 2 || total < (options.minVisitors ?? 100) || weightSum <= 0)
    return { status: 'insufficient', method: null, chiSquare: null, p: null };
  const threshold = options.threshold ?? 0.001;
  const shares = variants.map((v) => (weights[v] ?? 0) / weightSum);
  if (total <= EXACT_LIMIT && shares.some((share) => total * share < 5)) {
    const ps = counts.map((count, i) => binomialTwoSidedP(count, total, shares[i]!));
    const p = variants.length === 2 ? ps[0]! : Math.min(1, variants.length * Math.min(...ps));
    return { status: p < threshold ? 'mismatch' : 'ok', method: 'exact', chiSquare: null, p };
  }
  let chi = 0;
  counts.forEach((count, i) => {
    const expected = total * shares[i]!;
    chi += (count - expected) ** 2 / expected;
  });
  const p = chiSquareSurvival(chi, variants.length - 1);
  return { status: p < threshold ? 'mismatch' : 'ok', method: 'chi-square', chiSquare: chi, p };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ExperimentDescription {
  name: string;
  /** The control variant (the flag's default). */
  control: string;
  /** Variant → weight. */
  weights: Record<string, number>;
  status: 'running' | 'paused' | 'concluded';
  winner?: string;
}

export interface ExperimentMetricResult {
  p75: number;
  samples: number;
  rating: VitalRating;
  /** Relative change against the control's p75 (−0.1 = 10 % lower); absent for the control itself. */
  deltaVsControl?: number;
}

export interface ExperimentVariantResult {
  variant: string;
  isControl: boolean;
  /** `false` for a variant seen in the data that the experiment no longer defines. */
  defined: boolean;
  visitors: number;
  /** Share of all exposed visitors (0–1). */
  share: number;
  /** Share the weights ask for (0–1). */
  expectedShare: number;
  metrics: Partial<Record<VitalName, ExperimentMetricResult>>;
}

export interface ExperimentReport {
  name: string;
  status: ExperimentDescription['status'];
  winner?: string;
  control: string;
  days: number;
  /** Start of the window when one was given (ISO timestamp, UTC); the window is then `since` .. now, not `days`. */
  since?: string;
  visitors: number;
  variants: ExperimentVariantResult[];
  sampleRatio: SampleRatioCheck;
  /** First and last exposure in the window, epoch milliseconds. */
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface ExperimentRows {
  /** `experimentExposuresSql` rows. */
  exposures: Array<Record<string, unknown>>;
  /** `experimentVitalsSql` rows per variant. */
  vitals: Record<string, Array<Record<string, unknown>>>;
}

const toNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toTime = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
};

/** Turns the query rows of one experiment into the report the CLI prints. */
export function buildExperimentReport(
  description: ExperimentDescription,
  rows: ExperimentRows,
  options: { days: number; since?: Date | number | string },
): ExperimentReport {
  const mine = rows.exposures.filter((r) => String(r.experiment ?? '') === description.name);
  const observed: Record<string, number> = {};
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;
  for (const r of mine) {
    const variant = String(r.variant ?? '');
    observed[variant] = (observed[variant] ?? 0) + Math.round(toNumber(r.visitors));
    const first = toTime(r.first_seen);
    const last = toTime(r.last_seen);
    if (first !== null) firstSeen = firstSeen === null ? first : Math.min(firstSeen, first);
    if (last !== null) lastSeen = lastSeen === null ? last : Math.max(lastSeen, last);
  }
  const total = Object.values(observed).reduce((a, b) => a + b, 0);
  const weightSum = Object.values(description.weights).reduce((a, b) => a + Math.max(b, 0), 0);
  const names = [...new Set([...Object.keys(description.weights), ...Object.keys(observed)])];

  const metricsOf = (variant: string): Partial<Record<VitalName, ExperimentMetricResult>> => {
    const out: Partial<Record<VitalName, ExperimentMetricResult>> = {};
    for (const r of rows.vitals[variant] ?? []) {
      const metric = String(r.metric ?? '') as VitalName;
      if (!EXPERIMENT_METRICS.includes(metric)) continue;
      const p75 = toNumber(r.p75);
      out[metric] = { p75, samples: Math.round(toNumber(r.samples)), rating: rateVital(metric, p75) };
    }
    return out;
  };
  const control = metricsOf(description.control);
  const variants: ExperimentVariantResult[] = names.map((variant) => {
    const metrics = metricsOf(variant);
    if (variant !== description.control)
      for (const [metric, result] of Object.entries(metrics) as Array<[VitalName, ExperimentMetricResult]>) {
        const base = control[metric]?.p75;
        if (base !== undefined && base > 0) result.deltaVsControl = (result.p75 - base) / base;
      }
    const weight = description.weights[variant];
    return {
      variant,
      isControl: variant === description.control,
      defined: weight !== undefined,
      visitors: observed[variant] ?? 0,
      share: total > 0 ? (observed[variant] ?? 0) / total : 0,
      expectedShare: weight !== undefined && weightSum > 0 ? Math.max(weight, 0) / weightSum : 0,
      metrics,
    };
  });
  variants.sort((a, b) => Number(b.isControl) - Number(a.isControl) || a.variant.localeCompare(b.variant));
  const definedObserved = Object.fromEntries(
    Object.keys(description.weights).map((v) => [v, observed[v] ?? 0]),
  );
  return {
    name: description.name,
    status: description.status,
    ...(description.winner ? { winner: description.winner } : {}),
    control: description.control,
    days: options.days,
    ...(options.since !== undefined ? { since: windowStart(options.since).toISOString() } : {}),
    visitors: total,
    variants,
    sampleRatio: sampleRatioCheck(definedObserved, description.weights),
    firstSeen,
    lastSeen,
  };
}

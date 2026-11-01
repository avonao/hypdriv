import { HypDrivError } from '@hypdriv/core';
import { buildVitalsSnapshot, trendBucketSeconds, VITAL_NAMES } from './stats';
import type { VitalsQuery, VitalsSnapshot, VitalsSource } from './types';

const DATASET_RE = /^[A-Za-z0-9_]+$/;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface VitalsSqlOptions {
  days: number;
  route?: string | null;
  limit?: number;
}

function filters(dataset: string, options: VitalsSqlOptions): string {
  if (!DATASET_RE.test(dataset))
    throw new HypDrivError('E_VALIDATION', `invalid Analytics Engine dataset name "${dataset}"`);
  const where = [
    `timestamp > NOW() - INTERVAL '${Math.min(90, Math.max(1, Math.floor(options.days)))}' DAY`,
    // Spans exported with `tracing.exporter: 'analytics-engine'` and CSP reports can share the dataset;
    // only vitals rows count.
    `blob1 IN (${VITAL_NAMES.map((n) => `'${n}'`).join(', ')})`,
  ];
  if (options.route)
    where.push(`(index1 = ${sqlString(options.route)} OR blob3 = ${sqlString(options.route)})`);
  return where.join(' AND ');
}

/**
 * Analytics Engine SQL for p75 per route and metric over the vitals layout written by
 * `analyticsEngineVitalsSink` (index1 = route, blob1 = metric, blob2 = rating, blob3 = pathname,
 * double1 = value). Sampling is honoured through `_sample_interval` weights.
 */
export function vitalsSql(dataset: string, options: VitalsSqlOptions): string {
  return [
    'SELECT index1 AS route, blob1 AS metric,',
    '  quantileWeighted(0.75, double1, _sample_interval) AS p75,',
    '  quantileWeighted(0.5, double1, _sample_interval) AS p50,',
    '  SUM(_sample_interval) AS samples',
    `FROM ${dataset}`,
    `WHERE ${filters(dataset, options)}`,
    'GROUP BY route, metric',
    'ORDER BY samples DESC',
    `LIMIT ${options.limit ?? 500}`,
    'FORMAT JSON',
  ].join('\n');
}

/** p75 per metric across every route (a p75 of per-route p75s would be wrong, so it is its own query). */
export function vitalsOverallSql(dataset: string, options: VitalsSqlOptions): string {
  return [
    'SELECT blob1 AS metric,',
    '  quantileWeighted(0.75, double1, _sample_interval) AS p75,',
    '  quantileWeighted(0.5, double1, _sample_interval) AS p50,',
    '  SUM(_sample_interval) AS samples',
    `FROM ${dataset}`,
    `WHERE ${filters(dataset, options)}`,
    'GROUP BY metric',
    'FORMAT JSON',
  ].join('\n');
}

/** Share of measurements per metric and rating (blob2). */
export function vitalsDistributionSql(dataset: string, options: VitalsSqlOptions): string {
  return [
    'SELECT blob1 AS metric, blob2 AS rating, SUM(_sample_interval) AS samples',
    `FROM ${dataset}`,
    `WHERE ${filters(dataset, options)}`,
    'GROUP BY metric, rating',
    'FORMAT JSON',
  ].join('\n');
}

/** p75 per metric and time bucket. */
export function vitalsTrendSql(
  dataset: string,
  options: VitalsSqlOptions & { bucketSeconds?: number },
): string {
  const seconds = options.bucketSeconds ?? trendBucketSeconds(options.days);
  const interval =
    seconds % 86_400 === 0
      ? `INTERVAL '${seconds / 86_400}' DAY`
      : seconds % 3600 === 0
        ? `INTERVAL '${seconds / 3600}' HOUR`
        : `INTERVAL '${Math.max(1, Math.round(seconds / 60))}' MINUTE`;
  return [
    `SELECT toStartOfInterval(timestamp, ${interval}) AS bucket, blob1 AS metric,`,
    '  quantileWeighted(0.75, double1, _sample_interval) AS p75,',
    '  SUM(_sample_interval) AS samples',
    `FROM ${dataset}`,
    `WHERE ${filters(dataset, options)}`,
    'GROUP BY bucket, metric',
    'ORDER BY bucket ASC',
    'LIMIT 2000',
    'FORMAT JSON',
  ].join('\n');
}

/** A failed Analytics Engine SQL request. `status` is `null` when the request never got an answer. */
export class AnalyticsEngineQueryError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AnalyticsEngineQueryError';
    this.status = status;
  }
}

export interface AnalyticsEngineQueryOptions {
  accountId: string;
  /** API token with Account Analytics: Read. */
  apiToken: string;
  sql: string;
  fetch?: typeof fetch;
  /** Default 15 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs one query against the Workers Analytics Engine SQL API and returns the `data` rows. */
export async function queryAnalyticsEngine(
  options: AnalyticsEngineQueryOptions,
): Promise<Array<Record<string, unknown>>> {
  if (!ACCOUNT_RE.test(options.accountId))
    throw new HypDrivError('E_VALIDATION', 'The Cloudflare account id looks invalid');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiToken}`, 'content-type': 'text/plain' },
        body: options.sql,
        signal,
      },
    );
  } catch (err) {
    const timedOut = timeout.aborted;
    throw new AnalyticsEngineQueryError(
      timedOut
        ? 'Analytics Engine did not answer in time'
        : `Analytics Engine request failed: ${(err as Error).message}`,
      null,
      { cause: err },
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? ' (the API token needs Account Analytics: Read for this account)'
        : '';
    throw new AnalyticsEngineQueryError(
      `Analytics Engine returned ${res.status}${hint}: ${text.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    return Array.isArray(parsed.data) ? (parsed.data as Array<Record<string, unknown>>) : [];
  } catch (err) {
    throw new AnalyticsEngineQueryError('Analytics Engine returned a response that is not JSON', res.status, {
      cause: err,
    });
  }
}

export interface AnalyticsEngineVitalsSourceOptions {
  accountId: string;
  apiToken: string;
  /** The dataset behind the `HYPDRIV_ANALYTICS` binding (`analytics_engine_datasets[].dataset`). */
  dataset: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Routes kept in the table (default 50). */
  maxRoutes?: number;
}

/** Reads vitals back from Workers Analytics Engine: the rows `analyticsEngineVitalsSink` wrote. */
export function analyticsEngineVitalsSource(options: AnalyticsEngineVitalsSourceOptions): VitalsSource {
  // Fail on construction, not on the first request, when the dataset name cannot be put in SQL.
  filters(options.dataset, { days: 1 });
  return {
    async query(query: VitalsQuery): Promise<VitalsSnapshot> {
      const days = Math.min(90, Math.max(1, Math.floor(query.days)));
      const sqlOptions: VitalsSqlOptions = { days, route: query.route ?? null };
      const bucketSeconds = trendBucketSeconds(days);
      const run = (sql: string) =>
        queryAnalyticsEngine({
          accountId: options.accountId,
          apiToken: options.apiToken,
          sql,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(query.signal ? { signal: query.signal } : {}),
        });
      const [overall, routes, trend, distribution] = await Promise.all([
        run(vitalsOverallSql(options.dataset, sqlOptions)),
        run(vitalsSql(options.dataset, sqlOptions)),
        run(vitalsTrendSql(options.dataset, { ...sqlOptions, bucketSeconds })),
        run(vitalsDistributionSql(options.dataset, sqlOptions)),
      ]);
      return buildVitalsSnapshot(
        {
          overall: overall as never,
          routes: routes as never,
          trend: trend as never,
          distribution: distribution as never,
        },
        {
          source: {
            kind: 'analytics-engine',
            label: `Analytics Engine · ${options.dataset}`,
            partial: false,
          },
          days,
          route: query.route ?? null,
          now: query.now ?? Date.now(),
          bucketSeconds,
          ...(options.maxRoutes ? { maxRoutes: options.maxRoutes } : {}),
        },
      );
    },
  };
}

export interface CachedVitalsSourceOptions {
  /** How long a snapshot is reused (default 60 s). Analytics Engine data is minutes old anyway. */
  ttlSeconds?: number;
  /** Distinct (window, route) snapshots kept (default 32). */
  maxEntries?: number;
}

/** Reuses recent snapshots and shares one in-flight query between concurrent viewers. */
export function cachedVitalsSource(
  source: VitalsSource,
  options: CachedVitalsSourceOptions = {},
): VitalsSource {
  const ttl = (options.ttlSeconds ?? 60) * 1000;
  const max = options.maxEntries ?? 32;
  const entries = new Map<
    string,
    { at: number; value?: VitalsSnapshot; pending?: Promise<VitalsSnapshot> }
  >();
  return {
    async query(query) {
      const key = `${query.days}\u0000${query.route ?? ''}`;
      const now = query.now ?? Date.now();
      const hit = entries.get(key);
      if (hit?.value && now - hit.at < ttl) return hit.value;
      if (hit?.pending) return hit.pending;
      const pending = source.query(query).then(
        (value) => {
          entries.delete(key);
          entries.set(key, { at: now, value });
          while (entries.size > max) entries.delete(entries.keys().next().value as string);
          return value;
        },
        (err) => {
          // A failed query leaves nothing behind, so the next viewer retries.
          if (entries.get(key)?.pending === pending) entries.delete(key);
          throw err;
        },
      );
      entries.set(key, { at: now, pending });
      return pending;
    },
  };
}

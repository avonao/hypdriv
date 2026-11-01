import { HypDrivError } from '@hypdriv/core';

/**
 * Hot pages: the paths real visitors load most, read from the Web Vitals in Analytics Engine. Every navigation
 * reports one `TTFB` (blob1) with its pathname (blob3), so the sample-weighted row count per pathname is the page
 * view count. The result drives cache warming (`cache.warm.hot`, `hypdriv warm --hot`).
 */

const DATASET_RE = /^[A-Za-z0-9_]+$/;
/** Pathnames come from a public beacon: the longest we accept, and the internal paths that are never pages. */
const MAX_PATH_LENGTH = 512;
const INTERNAL_PATH = /^\/(?:_hypdriv(?:\/|$)|__)/;

export interface HotPathsSqlOptions {
  days: number;
  /** How many pages the caller wants; the query over-fetches so that rejected pathnames do not leave a gap. */
  limit: number;
}

export function hotPathsSql(dataset: string, options: HotPathsSqlOptions): string {
  if (!DATASET_RE.test(dataset))
    throw new HypDrivError('E_VALIDATION', `invalid Analytics Engine dataset name "${dataset}"`);
  const days = Math.min(90, Math.max(1, Math.floor(options.days)));
  const rows = Math.min(1000, Math.max(1, Math.floor(options.limit)) * 3);
  return [
    'SELECT blob3 AS pathname, SUM(_sample_interval) AS views',
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob1 = 'TTFB'`,
    'GROUP BY pathname',
    'ORDER BY views DESC',
    `LIMIT ${rows}`,
    'FORMAT JSON',
  ].join('\n');
}

/**
 * A pathname that is safe to request from inside the deployment: an absolute path without a scheme-relative
 * prefix (`//host`), backslashes, whitespace or control characters, query or fragment. Returns `null` otherwise.
 */
export function sanitizeHotPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\\\s?#\u0000-\u001f\u007f]/.test(value)) return null;
  if (INTERNAL_PATH.test(value)) return null;
  // Dot segments would resolve outside the path the beacon claimed.
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return value;
}

export interface HotPath {
  path: string;
  /** Measured page views in the window (sample-weighted). */
  views: number;
}

/**
 * Turns `hotPathsSql` rows into at most `limit` safe pathnames with at least `minViews` views, busiest first.
 * `accept` filters before the limit applies (for example "the edge cache would keep this page").
 */
export function hotPaths(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: { limit: number; minViews: number; accept?: (path: string) => boolean },
): HotPath[] {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const path = sanitizeHotPath(row.pathname);
    const views = Number(row.views);
    if (path === null || !Number.isFinite(views) || views < options.minViews) continue;
    if (options.accept && !options.accept(path)) continue;
    merged.set(path, (merged.get(path) ?? 0) + views);
  }
  return [...merged.entries()]
    .map(([path, views]) => ({ path, views: Math.round(views) }))
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, options.limit));
}

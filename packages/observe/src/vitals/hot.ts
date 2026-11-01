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

/** An integer in `[min, max]`; `fallback` for NaN, Infinity or anything that is not a number. */
function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export interface HotPathsSqlOptions {
  days: number;
  /** How many pages the caller wants; the query over-fetches so that rejected pathnames do not leave a gap. */
  limit: number;
}

export function hotPathsSql(dataset: string, options: HotPathsSqlOptions): string {
  if (!DATASET_RE.test(dataset))
    throw new HypDrivError('E_VALIDATION', `invalid Analytics Engine dataset name "${dataset}"`);
  const days = boundedInt(options.days, 1, 90, 7);
  const rows = Math.min(1000, boundedInt(options.limit, 1, 1000, 25) * 3);
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const UNSAFE_RAW = /[\\\s?#\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const UNSAFE_DECODED = /[/\\\u0000-\u001f\u007f\u2028\u2029]/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * One path segment in canonical form, or `null` when it is not safe. Checked on what the segment *decodes* to (a
 * dot segment, a separator, a control character or a second layer of percent-encoding is refused), then written
 * the way RFC 3986 normalises it: percent-encoded unreserved characters decoded, other escapes in upper case, raw
 * non-ASCII characters escaped. So `%2e%2e`, `%5Fhypdriv` and `caf%c3%a9` cannot hide what they are, and equal
 * paths are spelled alike.
 */
function canonicalSegment(raw: string): string | null {
  let escaped: string;
  let decoded: string;
  try {
    escaped = raw.replace(/[^\x21-\x7e]/g, (char) => encodeURIComponent(char));
    decoded = decodeURIComponent(escaped);
  } catch {
    return null;
  }
  if (decoded === '.' || decoded === '..' || UNSAFE_DECODED.test(decoded)) return null;
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) return null;
  return escaped.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * The canonical form of a pathname that is safe to request from inside the deployment, or `null`: an absolute path
 * without a scheme-relative prefix (`//host`), backslashes, whitespace or control characters, query or fragment,
 * with no dot segment and no internal path (`/_hypdriv`, `/__`) once percent-encoding is resolved. Equal paths in
 * different spellings (`/%70ricing`, `/pricing`) come out identical, so they are deduplicated and counted together.
 */
export function sanitizeHotPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (UNSAFE_RAW.test(value)) return null;
  const segments: string[] = [];
  for (const raw of value.slice(1).split('/')) {
    const segment = canonicalSegment(raw);
    if (segment === null) return null;
    segments.push(segment);
  }
  const path = `/${segments.join('/')}`;
  return INTERNAL_PATH.test(path) ? null : path;
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

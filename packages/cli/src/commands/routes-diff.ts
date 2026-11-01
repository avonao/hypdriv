import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertManifest, type HypManifest, type RouteClassification } from '@hypdriv/core';
import { CliError } from '../context';
import { type RouteRow, routeRows } from './route-rows';

/** What changed for a route between two builds. */
export type RouteChangeKind =
  | 'added'
  | 'removed'
  | 'route-kind'
  | 'classification'
  | 'ensure-static'
  | 'revalidate'
  | 'csp'
  | 'cache-policy'
  | 'prerendered-paths'
  | 'js-weight'
  | 'css-weight';

/**
 * `regression`: the route got less cacheable or lost a guarantee (static → dynamic, hash → nonce CSP, cache policy
 * dropped, prerendered paths gone). `improvement`: the reverse. `info`: a change that is neither.
 */
export type RouteChangeSeverity = 'regression' | 'improvement' | 'info';

export interface RouteChange {
  route: string;
  id: string;
  kind: RouteChangeKind;
  severity: RouteChangeSeverity;
  from: string;
  to: string;
  /** Why the change matters (only for regressions and improvements). */
  note?: string;
}

export interface RouteDiffOptions {
  /** Include `/_not-found` and friends. */
  all?: boolean;
  /** Compare client JS/CSS weights (changes beyond the threshold are regressions or improvements). */
  weights?: boolean;
  /** Relative weight change that counts (default 10 %). Changes under 1 KB never count. */
  weightThreshold?: number;
}

export interface RouteDiff {
  changes: RouteChange[];
  summary: {
    added: number;
    removed: number;
    regressions: number;
    improvements: number;
    info: number;
    unchanged: number;
    /** Routes present in both builds (compared), changed or not. `0` means the two builds share no routes. */
    matched: number;
  };
}

/** How dynamic each page classification is: a higher rank is rendered more often. */
const RANK: Partial<Record<RouteClassification, number>> = { static: 0, isr: 1, shell: 2, dynamic: 3 };

const MIN_WEIGHT_DELTA = 1024;

const revalidateLabel = (v: RouteRow['revalidate']): string =>
  v === null ? '—' : v === false ? 'never' : `${v}s`;

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

function classificationChange(
  before: RouteRow,
  after: RouteRow,
  ensureStatic: HypManifest['routes'][number]['ensureStatic'],
): RouteChange | null {
  if (before.classification === after.classification) return null;
  const from = RANK[before.classification];
  const to = RANK[after.classification];
  const base = {
    route: after.route,
    id: after.id,
    kind: 'classification' as const,
    from: before.classification,
    to: after.classification,
  };
  if (from === undefined || to === undefined) return { ...base, severity: 'info' };
  if (to > from) {
    const guarded = ensureStatic ? ` The route declares ensureStatic: '${ensureStatic}'.` : '';
    return {
      ...base,
      severity: 'regression',
      note: `Rendered more often than before (${
        to === 3 ? 'every request renders it' : 'it regenerates or renders a shell per request'
      }).${guarded} Look for a new dynamic API (cookies(), headers(), searchParams, uncached fetch) or a removed generateStaticParams.`,
    };
  }
  return { ...base, severity: 'improvement', note: 'Served from the prerender more often than before.' };
}

/** A build-time `revalidate` that shrank (or grew) by more than half changes how often the route regenerates. */
function revalidateChange(
  before: RouteRow['revalidate'],
  after: RouteRow['revalidate'],
): { severity: RouteChangeSeverity; note?: string } {
  if (before === false && typeof after === 'number')
    return {
      severity: 'regression',
      note: `The route used to be generated once; it now regenerates every ${after}s.`,
    };
  if (typeof before === 'number' && after === false)
    return { severity: 'improvement', note: 'The route is generated once instead of on a timer.' };
  if (typeof before === 'number' && typeof after === 'number') {
    if (after < before / 2)
      return {
        severity: 'regression',
        note: `The route regenerates ${before === 0 || after === 0 ? 'far' : `${(before / after).toFixed(1)}×`} as often as before.`,
      };
    if (after > before * 2)
      return { severity: 'improvement', note: 'The route regenerates less often than before.' };
  }
  return { severity: 'info' };
}

/** Compares two manifests route by route (matched by route id, then by path when only the route kind changed). */
export function diffRoutes(
  baseline: HypManifest,
  current: HypManifest,
  options: RouteDiffOptions = {},
): RouteDiff {
  const before = new Map(routeRows(baseline, { all: options.all === true }).map((r) => [r.id, r]));
  const after = new Map(routeRows(current, { all: options.all === true }).map((r) => [r.id, r]));
  const ensureStatic = new Map(current.routes.map((r) => [r.id, r.ensureStatic]));
  const threshold = (options.weightThreshold ?? 10) / 100;
  const changes: RouteChange[] = [];
  let unchanged = 0;
  let matched = 0;

  // A route whose kind changed (a page that became an endpoint) has a new id; pair such routes by path so the
  // change reads as one change instead of an unrelated addition and removal.
  const pathsOf = (rows: Map<string, RouteRow>, other: Map<string, RouteRow>) => {
    const byPath = new Map<string, RouteRow[]>();
    for (const row of rows.values())
      if (!other.has(row.id)) byPath.set(row.route, [...(byPath.get(row.route) ?? []), row]);
    return byPath;
  };
  const leftoverBefore = pathsOf(before, after);
  const leftoverAfter = pathsOf(after, before);
  const reKinded = new Set<string>();
  for (const [route, rows] of leftoverBefore) {
    const now = leftoverAfter.get(route);
    const old = rows[0];
    const row = now?.[0];
    if (!old || !row || rows.length !== 1 || now?.length !== 1) continue;
    reKinded.add(old.id);
    reKinded.add(row.id);
    matched += 1;
    changes.push({
      route,
      id: row.id,
      kind: 'route-kind',
      severity: 'info',
      from: old.kind,
      to: row.kind,
      note: 'The route changed kind; its other properties are not compared.',
    });
  }

  for (const [id, row] of after) {
    if (reKinded.has(id)) continue;
    const old = before.get(id);
    if (!old) {
      changes.push({
        route: row.route,
        id,
        kind: 'added',
        severity: 'info',
        from: '—',
        to: row.classification,
      });
      continue;
    }
    matched += 1;
    const start = changes.length;
    const classification = classificationChange(old, row, ensureStatic.get(id));
    if (classification) changes.push(classification);

    if (old.revalidate !== row.revalidate && old.classification === row.classification) {
      const verdict = revalidateChange(old.revalidate, row.revalidate);
      changes.push({
        route: row.route,
        id,
        kind: 'revalidate',
        severity: verdict.severity,
        from: revalidateLabel(old.revalidate),
        to: revalidateLabel(row.revalidate),
        ...(verdict.note ? { note: verdict.note } : {}),
      });
    }

    // A hash policy exists for static documents only, so a classification change already explains the CSP mode.
    if (old.csp !== row.csp && !classification) {
      const lostHash = old.csp === 'hash' && row.csp === 'nonce';
      const gainedHash = old.csp === 'nonce' && row.csp === 'hash';
      changes.push({
        route: row.route,
        id,
        kind: 'csp',
        severity: lostHash ? 'regression' : gainedHash ? 'improvement' : 'info',
        from: old.csp,
        to: row.csp,
        ...(lostHash
          ? {
              note: 'The page is no longer covered by a build-time hash policy, so its HTML needs a per-request nonce and cannot be cached as a shared document.',
            }
          : gainedHash
            ? {
                note: 'The page is covered by a build-time hash policy and can be cached as a shared document.',
              }
            : {}),
      });
    }

    if (old.cachePolicy !== row.cachePolicy) {
      const dropped = old.cachePolicy !== null && row.cachePolicy === null;
      const gained = old.cachePolicy === null && row.cachePolicy !== null;
      changes.push({
        route: row.route,
        id,
        kind: 'cache-policy',
        severity: dropped ? 'regression' : gained ? 'improvement' : 'info',
        from: old.cachePolicy ?? '—',
        to: row.cachePolicy ?? '—',
        ...(dropped ? { note: 'The route no longer has an edge cache policy.' } : {}),
        ...(gained ? { note: 'The route now has an edge cache policy.' } : {}),
      });
    }

    const pathsBefore = old.prerenderedPaths ?? 0;
    const pathsAfter = row.prerenderedPaths ?? 0;
    if (pathsBefore !== pathsAfter) {
      const gone = pathsBefore > 0 && pathsAfter === 0;
      const mostlyGone = !gone && pathsAfter < pathsBefore / 2;
      changes.push({
        route: row.route,
        id,
        kind: 'prerendered-paths',
        severity: gone || mostlyGone ? 'regression' : 'info',
        from: String(pathsBefore),
        to: String(pathsAfter),
        ...(gone
          ? { note: 'No concrete path is prerendered any more: every request renders on demand.' }
          : mostlyGone
            ? { note: 'Most prerendered paths are gone: those requests render on demand.' }
            : {}),
      });
    }

    if (options.weights) {
      for (const [kind, key] of [
        ['js-weight', 'js'],
        ['css-weight', 'css'],
      ] as const) {
        const a = old[key];
        const b = row[key];
        if (a === null || b === null || Math.abs(b - a) < MIN_WEIGHT_DELTA) continue;
        if (Math.abs(b - a) / Math.max(a, 1) < threshold) continue;
        changes.push({
          route: row.route,
          id,
          kind,
          severity: b > a ? 'regression' : 'improvement',
          from: kb(a),
          to: kb(b),
        });
      }
    }

    if (changes.length === start) unchanged += 1;
  }

  for (const [id, row] of before)
    if (!after.has(id) && !reKinded.has(id))
      changes.push({
        route: row.route,
        id,
        kind: 'removed',
        severity: 'info',
        from: row.classification,
        to: '—',
      });

  const order: Record<RouteChangeSeverity, number> = { regression: 0, improvement: 1, info: 2 };
  changes.sort((a, b) => order[a.severity] - order[b.severity] || a.route.localeCompare(b.route));
  const count = (severity: RouteChangeSeverity) => changes.filter((c) => c.severity === severity).length;
  return {
    changes,
    summary: {
      added: changes.filter((c) => c.kind === 'added').length,
      removed: changes.filter((c) => c.kind === 'removed').length,
      regressions: count('regression'),
      improvements: count('improvement'),
      info: count('info'),
      unchanged,
      matched,
    },
  };
}

export type FailOn = 'regress' | 'change' | 'never';

/** Whether the diff should fail the run: `regress` (default), any `change`, or `never`. */
export function diffFails(diff: RouteDiff, failOn: FailOn): boolean {
  if (failOn === 'never') return false;
  if (failOn === 'change') return diff.changes.length > 0;
  return diff.summary.regressions > 0;
}

/** Exit code of a diff that could not be made (missing, unreadable, incomplete or unrelated baseline). */
export const BASELINE_ERROR_EXIT = 2;

const baselineError = (message: string) => new CliError(message, BASELINE_ERROR_EXIT);

/** What a diff reads from a manifest, beyond the three fields `assertManifest` checks. */
function assertBaselineShape(file: string, m: HypManifest): void {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const missing: string[] = [];
  if (!record(m.csp)) missing.push('csp');
  if (!record(m.earlyHints)) missing.push('earlyHints');
  if (!record(m.weights) || !record((m.weights as { client?: unknown }).client))
    missing.push('weights.client');
  if (m.routes.some((r) => !r || typeof r.id !== 'string' || typeof r.pathname !== 'string'))
    missing.push('routes[].id / routes[].pathname');
  if (missing.length > 0)
    throw baselineError(
      `Baseline ${file} is incomplete (missing ${missing.join(', ')}): it was cut down or written by another version. Pass the complete .hypdriv/manifest.json of the earlier build.`,
    );
}

/** Reads a baseline manifest: a file, or a directory holding `.hypdriv/manifest.json` or `manifest.json`. */
export function loadBaseline(target: string, cwd: string): HypManifest {
  const path = resolve(cwd, target);
  let file = path;
  try {
    if (statSync(path).isDirectory()) {
      const candidates = [join(path, '.hypdriv', 'manifest.json'), join(path, 'manifest.json')];
      const found = candidates.find((c) => {
        try {
          return statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!found) throw baselineError(`No manifest.json or .hypdriv/manifest.json in ${path}.`);
      file = found;
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw baselineError(
      `Baseline ${path} not found. Pass a manifest file from an earlier build (--diff <file>).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw baselineError(`Baseline ${file} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    assertManifest(parsed);
  } catch (err) {
    throw baselineError(`Baseline ${file} is not a Hypdriv manifest: ${(err as Error).message}`);
  }
  assertBaselineShape(file, parsed);
  return parsed;
}

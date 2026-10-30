/**
 * Minimal semantic-version helpers (no dependency): parsing, comparison, range bases and the
 * patch/minor/major classification used by `hypdriv deps` and `hypdriv doctor`.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `1.2.3`, `v1.2.3`, `1.2`, `1`, `1.2.3-beta.1+build`. Returns null for anything else. */
export function parseVersion(input: string | null | undefined): SemVer | null {
  if (!input) return null;
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: input.trim(),
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // release > prerelease
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Standard semver precedence: negative when `a < b`. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** `true` when `version >= minimum` (both parsed leniently). Unparseable input yields `false`. */
export function atLeast(version: string | null | undefined, minimum: string): boolean {
  const v = parseVersion(version);
  const m = parseVersion(minimum);
  if (!v || !m) return false;
  return compareVersions(v, m) >= 0;
}

/** `true` when `version < maximum`. */
export function below(version: string | null | undefined, maximum: string): boolean {
  const v = parseVersion(version);
  const m = parseVersion(maximum);
  if (!v || !m) return false;
  return compareVersions(v, m) < 0;
}

export type UpdateDiff = 'current' | 'patch' | 'minor' | 'major' | 'unknown';

export interface RangeBase {
  /** `^`, `~`, `>=`, `` (exact) or `*`/`x` wildcards. */
  operator: string;
  version: SemVer;
}

/**
 * Extracts the base version of a simple range: `^1.2.3`, `~1.2.3`, `1.2.3`, `>=1.2.3`, `=1.2.3`,
 * `1.2.x`, `1.x`. Complex ranges (`||`, hyphen ranges, multiple comparators) return null.
 */
export function rangeBase(range: string | null | undefined): RangeBase | null {
  if (!range) return null;
  const text = range.trim();
  if (!text || text === '*' || text === 'latest' || text === 'x') return null;
  if (text.includes('||') || text.includes(' - ') || /\s/.test(text)) return null;
  const m =
    /^(\^|~|>=|>|=|<=|<)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      text,
    );
  if (!m) return null;
  const operator = m[1] ?? '';
  if (operator === '<' || operator === '<=') return null;
  const wildcardMinor = m[3] === 'x' || m[3] === '*';
  const wildcardPatch = m[4] === 'x' || m[4] === '*';
  const version: SemVer = {
    major: Number(m[2]),
    minor: wildcardMinor || m[3] === undefined ? 0 : Number(m[3]),
    patch: wildcardPatch || m[4] === undefined ? 0 : Number(m[4]),
    prerelease: m[5] ? m[5].split('.') : [],
    raw: text,
  };
  return { operator: wildcardMinor ? '^' : wildcardPatch ? '~' : operator, version };
}

/**
 * Classifies `latest` against the base of `currentRange`. Prereleases are ignored unless the current
 * version is itself a prerelease.
 */
export function classifyUpdate(
  currentRange: string | null | undefined,
  latest: string | null | undefined,
): UpdateDiff {
  const base = rangeBase(currentRange);
  const next = parseVersion(latest);
  if (!base || !next) return 'unknown';
  const current = base.version;
  if (next.prerelease.length && current.prerelease.length === 0) return 'current';
  if (compareVersions(next, current) <= 0) return 'current';
  if (next.major !== current.major) return 'major';
  if (next.minor !== current.minor) return 'minor';
  if (next.patch !== current.patch) return 'patch';
  // same x.y.z, only the prerelease differs
  return current.prerelease.length ? 'patch' : 'current';
}

/** Highest stable version in a list (prereleases ignored unless nothing else exists). */
export function highestVersion(
  versions: string[],
  options: { allowPrerelease?: boolean } = {},
): string | null {
  let best: SemVer | null = null;
  let bestAny: SemVer | null = null;
  for (const raw of versions) {
    const v = parseVersion(raw);
    if (!v) continue;
    if (!bestAny || compareVersions(v, bestAny) > 0) bestAny = v;
    if (v.prerelease.length) continue;
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  const pick = best ?? (options.allowPrerelease ? bestAny : null);
  return pick ? pick.raw : null;
}

/** Rewrites a range to a new version while keeping its operator style (`^1.2.3` → `^1.4.0`). */
export function bumpRange(range: string, latest: string): string {
  const base = rangeBase(range);
  if (!base) return range;
  const text = range.trim();
  const op = /^(\^|~|>=|>|=)/.exec(text)?.[1] ?? '';
  const next = parseVersion(latest);
  if (!next) return range;
  if (/\.(x|\*)$/.test(text)) {
    // keep wildcard shape: 1.x → 2.x, 1.2.x → 1.3.x
    const parts = text.split('.');
    if (parts.length === 2) return `${next.major}.x`;
    return `${next.major}.${next.minor}.x`;
  }
  return `${op}${latest}`;
}

/** Months between two ISO dates (approximate, calendar based). */
export function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

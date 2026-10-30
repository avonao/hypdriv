import type { CspDirectives } from '@hypdriv/core';

/** Directives that take no value and are rendered bare. */
export const BOOLEAN_DIRECTIVES: ReadonlySet<string> = new Set([
  'upgrade-insecure-requests',
  'block-all-mixed-content',
]);

/** Fetch directives that fall back to `default-src` when absent. */
export const FETCH_DIRECTIVES: ReadonlySet<string> = new Set([
  'child-src',
  'connect-src',
  'font-src',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'object-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'worker-src',
]);

/** De-duplicates a source list, preserving the first occurrence; drops `'none'` when other sources exist. */
export function normalizeSources(sources: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    const src = raw.trim();
    if (!src) continue;
    const key = src.startsWith("'") ? src.toLowerCase() : src;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  if (out.length > 1) return out.filter((s) => s.toLowerCase() !== "'none'");
  return out;
}

/**
 * Merges directive sets left to right. Source lists are unioned (first occurrence order kept) and
 * boolean directives are OR-ed. A directive explicitly set to `false` in a later set removes it,
 * which lets per-route overrides drop a base directive.
 */
export function mergeDirectives(...sets: Array<CspDirectives | undefined | null>): CspDirectives {
  const out: CspDirectives = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [name, value] of Object.entries(set)) {
      const key = name.toLowerCase();
      if (value === undefined) continue;
      if (value === false) {
        delete out[key];
        continue;
      }
      if (value === true) {
        out[key] = true;
        continue;
      }
      const existing = out[key];
      const current = Array.isArray(existing) ? existing : [];
      out[key] = normalizeSources([...current, ...value]);
    }
  }
  return out;
}

/** Deterministic directive order: `default-src` first, then alphabetical. */
export function sortDirectiveNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => {
    if (a === b) return 0;
    if (a === 'default-src') return -1;
    if (b === 'default-src') return 1;
    return a < b ? -1 : 1;
  });
}

/**
 * Serialises directives into a `Content-Security-Policy` header value.
 * Boolean directives render bare; an empty source list renders the bare directive name, which the
 * CSP grammar treats as `'none'`.
 */
export function serializeCsp(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const name of sortDirectiveNames(Object.keys(directives))) {
    const value = directives[name];
    if (value === undefined || value === false) continue;
    if (value === true) {
      parts.push(name);
      continue;
    }
    const sources = normalizeSources(value);
    parts.push(sources.length ? `${name} ${sources.join(' ')}` : name);
  }
  return parts.join('; ');
}

/**
 * Parses a CSP header value. Duplicate directives keep the first occurrence (per spec, later
 * duplicates are ignored). Directive names are lower-cased; sources keep their case.
 */
export function parseCsp(header: string | null | undefined): CspDirectives {
  const out: CspDirectives = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift()?.toLowerCase();
    if (!name || name in out) continue;
    if (BOOLEAN_DIRECTIVES.has(name)) {
      out[name] = true;
      continue;
    }
    out[name] = normalizeSources(tokens);
  }
  return out;
}

/** Returns the effective source list of a directive, falling back to `default-src` for fetch directives. */
export function effectiveSources(directives: CspDirectives, directive: string): string[] | undefined {
  const own = directives[directive];
  if (Array.isArray(own)) return own;
  if (FETCH_DIRECTIVES.has(directive)) {
    const def = directives['default-src'];
    if (Array.isArray(def)) return def;
  }
  return undefined;
}

/** Removes a source expression from every directive (used for the stricter report-only copy). */
export function withoutSource(directives: CspDirectives, source: string): CspDirectives {
  const target = source.toLowerCase();
  const out: CspDirectives = {};
  for (const [name, value] of Object.entries(directives)) {
    out[name] = Array.isArray(value) ? value.filter((s) => s.toLowerCase() !== target) : value;
  }
  return out;
}

/** Extracts the nonce from a policy's `script-src` (`'nonce-abc'` → `abc`), if present. */
export function extractNonce(directives: CspDirectives): string | null {
  for (const directive of ['script-src', 'script-src-elem', 'default-src']) {
    const list = directives[directive];
    if (!Array.isArray(list)) continue;
    for (const src of list) {
      const m = /^'nonce-([A-Za-z0-9+/_=-]+)'$/.exec(src);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

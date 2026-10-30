/**
 * Route pattern matching used by every `match:` option.
 *
 * Syntax (strings):
 * - `/exact`                      exact path (a trailing slash is tolerated)
 * - `/blog/:slug`                 one segment parameter
 * - `/docs/:path*`                rest parameter (zero or more segments)
 * - `/files/*.pdf`                `*` matches within one segment
 * - `/api/**`                     `**` matches across segments (including none)
 * - `/search\?*q=*`               a literal `\?` switches matching to `pathname + search`
 * - `^/regex/(a|b)$`              a leading `^` is a raw regular expression
 *
 * `RegExp` values are used as-is against the pathname (or `pathname + search` when they contain `\?`).
 */

export type PathPattern = string | RegExp;

export interface PatternMatch {
  matched: boolean;
  params: Record<string, string>;
}

const cache = new Map<string, { regex: RegExp; withSearch: boolean }>();
const CACHE_LIMIT = 2000;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a string pattern into a regular expression. Exported for tooling and tests. */
export function compilePattern(pattern: string): { regex: RegExp; withSearch: boolean } {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let compiled: { regex: RegExp; withSearch: boolean };
  if (pattern.startsWith('^')) {
    compiled = { regex: new RegExp(pattern), withSearch: pattern.includes('\\?') };
  } else {
    const withSearch = pattern.includes('\\?');
    let out = '';
    let i = 0;
    while (i < pattern.length) {
      const ch = pattern[i]!;
      if (ch === '\\' && pattern[i + 1] === '?') {
        out += '\\?';
        i += 2;
        continue;
      }
      if (ch === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
        // `/**` : zero or more segments; `/**/` : zero or more segments then a slash
        if (pattern[i + 3] === '/') {
          out += '(?:/.*)?/';
          i += 4;
        } else {
          out += '(?:/.*)?';
          i += 3;
        }
        continue;
      }
      if (ch === '*') {
        if (pattern[i + 1] === '*') {
          out += '.*';
          i += 2;
        } else {
          out += '[^/?]*';
          i += 1;
        }
        continue;
      }
      if (ch === ':' && /[A-Za-z_]/.test(pattern[i + 1] ?? '')) {
        let j = i + 1;
        while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j]!)) j++;
        const name = pattern.slice(i + 1, j);
        if (pattern[j] === '*') {
          out += `(?<${name}>.*)`;
          j++;
        } else if (pattern[j] === '?') {
          out += `(?<${name}>[^/?]*)`;
          j++;
        } else {
          out += `(?<${name}>[^/?]+)`;
        }
        i = j;
        continue;
      }
      out += escapeRegex(ch);
      i += 1;
    }
    const endsOpen = pattern.endsWith('*');
    compiled = { regex: new RegExp(`^${out}${endsOpen ? '' : '/?'}$`), withSearch };
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(pattern, compiled);
  return compiled;
}

/** Matches one pattern against a URL (or pathname). */
export function matchPattern(pattern: PathPattern, target: URL | string): PatternMatch {
  const pathname = typeof target === 'string' ? target.split('?')[0]! : target.pathname;
  const search =
    typeof target === 'string'
      ? target.includes('?')
        ? target.slice(target.indexOf('?'))
        : ''
      : target.search;
  if (pattern instanceof RegExp) {
    const withSearch = pattern.source.includes('\\?');
    const m = pattern.exec(withSearch ? pathname + search : pathname);
    return { matched: !!m, params: { ...(m?.groups ?? {}) } };
  }
  const { regex, withSearch } = compilePattern(pattern);
  const m = regex.exec(withSearch ? pathname + search : pathname);
  return { matched: !!m, params: { ...(m?.groups ?? {}) } };
}

/** `true` when any pattern in the list (or the single pattern) matches. */
export function matchesAny(patterns: PathPattern | PathPattern[] | undefined, target: URL | string): boolean {
  if (!patterns) return false;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const p of list) if (matchPattern(p, target).matched) return true;
  return false;
}

/** Returns the first matching pattern (useful to report which rule fired). */
export function firstMatch<T extends { match: PathPattern | PathPattern[] }>(
  rules: readonly T[],
  target: URL | string,
): T | undefined {
  return rules.find((r) => matchesAny(r.match, target));
}

/** Specificity score for ordering inferred rules: more literal characters first, wildcards last. */
export function patternSpecificity(pattern: PathPattern): number {
  if (pattern instanceof RegExp) return pattern.source.replace(/[^A-Za-z0-9/]/g, '').length;
  const literal = pattern.replace(/\*\*|\*|:[A-Za-z0-9_]+\*?/g, '').length;
  const wild =
    (pattern.match(/\*\*/g)?.length ?? 0) * 10 +
    (pattern.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0) * 3 +
    (pattern.match(/:[A-Za-z0-9_]+/g)?.length ?? 0);
  return literal * 100 - wild;
}

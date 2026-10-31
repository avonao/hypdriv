import type { PathPattern } from '@hypdriv/core';

const SPECIAL = new Set(['(', ')', '{', '}', '[', ']', '?', '+', '*', ':', '\\']);

/**
 * Translates a Hypdriv route pattern into a Next.js `source` (path-to-regexp): `:name`, `:name*`, `:name?`,
 * `/**` (any depth) and `*` (within a segment) are supported; regular expressions, `^…` patterns and query
 * patterns (`\?`) are not and yield `null`.
 */
export function nextHeaderSource(pattern: PathPattern): string | null {
  if (typeof pattern !== 'string' || !pattern.startsWith('/') || pattern.includes('\\?')) return null;
  let out = '';
  let generated = 0;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
      const after = pattern[i + 3];
      if (after === '/') {
        out += `/:hyp${generated++}*/`;
        i += 4;
        continue;
      }
      if (after === undefined) {
        out += `/:hyp${generated++}*`;
        i += 3;
        continue;
      }
      return null;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += `:hyp${generated++}(.*)`;
        i += 2;
      } else {
        out += `:hyp${generated++}([^/]*)`;
        i += 1;
      }
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(pattern[i + 1] ?? '')) {
      let j = i + 1;
      while (j < pattern.length && /\w/.test(pattern[j]!)) j++;
      const name = pattern.slice(i + 1, j);
      const modifier = pattern[j];
      const segmentStart = out.endsWith('/');
      if (modifier === '*') {
        out += segmentStart ? `:${name}*` : `:${name}(.*)`;
        j++;
      } else if (modifier === '?') {
        out += segmentStart ? `:${name}?` : `:${name}([^/]*)`;
        j++;
      } else {
        out += `:${name}`;
      }
      i = j;
      continue;
    }
    out += SPECIAL.has(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  return out || '/';
}

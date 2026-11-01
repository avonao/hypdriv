import { insertImport } from './next-config';

/**
 * Text edits for JavaScript/TypeScript config files (`vite.config.ts`, `astro.config.mjs`, `nuxt.config.ts`,
 * `react-router.config.ts`, `svelte.config.js`). Files are never executed: edits are targeted string insertions
 * that keep formatting and comments, and anything ambiguous is left for a manual step.
 */

export interface ConfigEditResult {
  changed: boolean;
  content: string;
  reason: string;
}

/** Whether `module` is imported (ESM `from 'module'` or a bare `import 'module'`). */
export function importsModule(source: string, module: string): boolean {
  const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?:from\\s*|import\\s*\\(?\\s*)['"]${escaped}['"]`).test(source);
}

function indentAt(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? '';
}

function skipString(source: string, i: number): number {
  const quote = source[i]!;
  let j = i + 1;
  while (j < source.length && source[j] !== quote) {
    if (source[j] === '\\') j++;
    else if (quote === '`' && source[j] === '$' && source[j + 1] === '{') {
      j = matchClose(source, j + 1);
    }
    j++;
  }
  return j;
}

/** Index of the bracket that closes the one at `open` (`(`, `[`, `{`), skipping strings and comments. */
export function matchClose(source: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/**
 * Where the exported config object starts: `defineConfig({`, `defineNuxtConfig({`, `export default {`, and the
 * function form that returns the object, `defineConfig(({ mode }) => ({` (Analog's template).
 */
export function configObjectStart(source: string): number {
  const call = /export\s+default\s+(?:[\w$.]+\s*\(\s*)?\{/.exec(source);
  if (call) return call.index + call[0].length - 1;
  const arrow =
    /export\s+default\s+[\w$.]+\s*\(\s*(?:async\s*)?\([^()]*\)\s*(?::\s*[\w$.<>[\]]+\s*)?=>\s*\(\s*\{/.exec(
      source,
    );
  if (arrow) return arrow.index + arrow[0].length - 1;
  const named = /(?:const|let)\s+(\w+)\s*(?::\s*[\w.<>]+\s*)?=\s*(?:[\w$.]+\s*\(\s*)?\{/.exec(source);
  if (named && new RegExp(`export\\s+default\\s+(?:[\\w$.]+\\s*\\(\\s*)?${named[1]}\\b`).test(source))
    return named.index + named[0].length - 1;
  return -1;
}

/**
 * Adds `element` to the array under `property` of the exported config object (creating the property when the
 * object has none) and the import, e.g. `plugins: [hypdriv()]` with `import { hypdriv } from '@hypdriv/vite'`.
 * `present` decides whether the element is already there (default: the element's callee appears in the array).
 */
export function addToConfigArray(
  source: string,
  options: {
    property: string;
    element: string;
    importLine?: string;
    importFrom?: string;
    /** Insert as the first element (default) or the last. */
    position?: 'first' | 'last';
    /** Insert right before the first element matching this (e.g. `/reactRouter\s*\(/`); falls back to `position`. */
    before?: RegExp;
    present?: RegExp;
  },
): ConfigEditResult {
  const start = configObjectStart(source);
  if (start === -1) return { changed: false, content: source, reason: 'no exported config object found' };
  const end = matchClose(source, start);
  if (end === -1) return { changed: false, content: source, reason: 'could not parse the config object' };
  const object = source.slice(start, end + 1);
  const callee = /^[\w$.]+/.exec(options.element)?.[0] ?? options.element;
  const present = options.present ?? new RegExp(`(^|[^\\w$.])${callee.replace(/[.$]/g, '\\$&')}\\s*\\(`);

  let out = source;
  let changed = false;
  const prop = new RegExp(`(^|[\\s,{])${options.property}\\s*:\\s*\\[`).exec(object);
  if (prop) {
    const open = start + prop.index + prop[0].length - 1;
    const close = matchClose(source, open);
    if (close === -1)
      return { changed: false, content: source, reason: `could not parse ${options.property}` };
    const inner = source.slice(open + 1, close);
    if (!present.test(inner)) {
      const multiline = /^\s*\n/.test(inner);
      const empty = inner.trim() === '';
      const anchor = options.before ? options.before.exec(inner) : null;
      if (anchor) {
        const at = open + 1 + anchor.index;
        out = `${source.slice(0, at)}${options.element},${multiline ? `\n${indentAt(source, at)}` : ' '}${source.slice(at)}`;
      } else if (empty) out = `${source.slice(0, open + 1)}${options.element}${source.slice(close)}`;
      else if (options.position === 'last') {
        const trimmed = inner.replace(/\s*$/, '');
        const comma = trimmed.endsWith(',') ? '' : ',';
        const indent = multiline ? `\n${indentAt(source, open)}  ` : ' ';
        const tail = inner.slice(trimmed.length);
        out = `${source.slice(0, open + 1)}${trimmed}${comma}${indent}${options.element}${multiline ? (tail.includes('\n') ? tail : `\n${indentAt(source, open)}`) : tail}${source.slice(close)}`;
      } else if (multiline) {
        const indent = `${indentAt(source, open)}  `;
        out = `${source.slice(0, open + 1)}\n${indent}${options.element},${source.slice(open + 1)}`;
      } else out = `${source.slice(0, open + 1)}${options.element}, ${source.slice(open + 1)}`;
      changed = true;
    }
  } else {
    const indent = `${indentAt(source, start)}  `;
    const body = source.slice(start + 1, end);
    const insert = body.trim()
      ? `\n${indent}${options.property}: [${options.element}],`
      : `\n${indent}${options.property}: [${options.element}],\n${indentAt(source, start)}`;
    out = `${source.slice(0, start + 1)}${insert}${source.slice(start + 1)}`;
    changed = true;
  }
  if (options.importLine && options.importFrom && !importsModule(out, options.importFrom)) {
    out = insertImport(out, options.importLine, 'esm');
    changed = true;
  }
  return {
    changed,
    content: out,
    reason: changed ? `register ${callee} in ${options.property}` : `${callee} already registered`,
  };
}

/** Index just past the expression that starts at `start` (stops at a top-level `,`, `)`, `]` or `}`). */
function expressionEnd(source: string, start: number): number {
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (c === '(' || c === '[' || c === '{') {
      const close = matchClose(source, i);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        j++;
      }
      i = j;
      continue;
    }
    if (c === ',' || c === ')' || c === ']' || c === '}') return i;
  }
  return source.length;
}

/**
 * Wraps the first argument of the first `callee(...)` call: `tanstackStart({ … })` → `tanstackStart(withHypDriv({ … }))`
 * (`tanstackStart()` → `tanstackStart(withHypDriv())`). Unchanged when the argument is already wrapped.
 */
export function wrapCallArgument(
  source: string,
  options: { callee: string; wrapper: string; importLine: string; importFrom: string },
): ConfigEditResult {
  const call = new RegExp(`(^|[^\\w$.])${options.callee.replace(/[.$]/g, '\\$&')}\\s*\\(`).exec(source);
  if (!call) return { changed: false, content: source, reason: `no ${options.callee}() call found` };
  const open = call.index + call[0].length - 1;
  const close = matchClose(source, open);
  if (close === -1) return { changed: false, content: source, reason: `could not parse ${options.callee}()` };
  const inner = source.slice(open + 1, close);
  if (new RegExp(`^\\s*${options.wrapper}\\s*\\(`).test(inner))
    return { changed: false, content: source, reason: `${options.callee}() options already wrapped` };
  let out: string;
  if (!inner.trim()) out = `${source.slice(0, open + 1)}${options.wrapper}()${source.slice(close)}`;
  else {
    const argStart = open + 1 + (inner.length - inner.trimStart().length);
    const argEnd = expressionEnd(source, argStart);
    if (argEnd === -1)
      return { changed: false, content: source, reason: `could not parse ${options.callee}()` };
    const arg = source.slice(argStart, argEnd).replace(/\s+$/, '');
    out = `${source.slice(0, argStart)}${options.wrapper}(${arg})${source.slice(argStart + arg.length)}`;
  }
  const imports = out
    .split(/\n/)
    .filter((l) => /^\s*import\b/.test(l))
    .join('\n');
  if (!new RegExp(`\\b${options.wrapper}\\b`).test(imports))
    out = insertImport(out, options.importLine, 'esm');
  return { changed: true, content: out, reason: `wrap ${options.callee}() options in ${options.wrapper}()` };
}

/**
 * Wraps the value of `property` inside the first `within(...)` call (or anywhere when `within` is omitted):
 * `sveltekit({ adapter: adapter() })` → `sveltekit({ adapter: hypdriv(adapter()) })`.
 */
export function wrapPropertyValue(
  source: string,
  options: { property: string; wrapper: string; within?: string; importLine: string; importFrom: string },
): ConfigEditResult {
  let from = 0;
  let to = source.length;
  if (options.within) {
    const call = new RegExp(`(^|[^\\w$.])${options.within}\\s*\\(`).exec(source);
    if (!call) return { changed: false, content: source, reason: `no ${options.within}() call found` };
    from = call.index + call[0].length - 1;
    to = matchClose(source, from);
    if (to === -1) return { changed: false, content: source, reason: `could not parse ${options.within}()` };
  }
  const prop = new RegExp(`(^|[\\s,{])${options.property}\\s*:\\s*`).exec(source.slice(from, to));
  if (!prop) return { changed: false, content: source, reason: `no ${options.property} option found` };
  const valueStart = from + prop.index + prop[0].length;
  if (new RegExp(`^${options.wrapper}\\s*\\(`).test(source.slice(valueStart)))
    return { changed: false, content: source, reason: `${options.property} already wrapped` };
  const valueEnd = expressionEnd(source, valueStart);
  if (valueEnd === -1)
    return { changed: false, content: source, reason: `could not parse ${options.property}` };
  const value = source.slice(valueStart, valueEnd).replace(/\s+$/, '');
  let out = `${source.slice(0, valueStart)}${options.wrapper}(${value})${source.slice(valueStart + value.length)}`;
  if (!importsModule(out, options.importFrom)) out = insertImport(out, options.importLine, 'esm');
  return { changed: true, content: out, reason: `wrap ${options.property} in ${options.wrapper}()` };
}

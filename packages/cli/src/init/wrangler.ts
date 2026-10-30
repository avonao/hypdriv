import { parseJsonc } from '../wrangler-config';

export interface WranglerEditOptions {
  main: string;
  /** Ensure `observability.enabled` (default true). */
  observability?: boolean;
  /** Cron expressions that must be present in `triggers.crons`. */
  crons?: string[];
}

export interface WranglerEditResult {
  content: string;
  /** Human-readable list of what changed (empty when nothing changed). */
  changes: string[];
}

function rootOpenBrace(source: string): number {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    return ch === '{' ? i : -1;
  }
  return -1;
}

function detectIndent(source: string): string {
  const m = /\n([ \t]+)"/.exec(source);
  return m?.[1] ?? '  ';
}

function eolOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

/** Index just past the end of the line that contains `index`. */
function lineEnd(source: string, index: number): number {
  const nl = source.indexOf('\n', index);
  return nl === -1 ? source.length : nl + 1;
}

/** Position of the root-level key's value start (the `"key":` match), or -1. */
function findRootKey(source: string, key: string): RegExpExecArray | null {
  // Root keys sit at the indentation of the first key; nested keys are deeper. We approximate by
  // requiring the match to start at the beginning of a line (after indentation).
  const re = new RegExp(`^([ \\t]*)"${key}"\\s*:`, 'm');
  return re.exec(source);
}

function insertRootLine(source: string, line: string, afterKey?: string): string {
  const eol = eolOf(source);
  const indent = detectIndent(source);
  if (afterKey) {
    const m = findRootKey(source, afterKey);
    if (m) {
      // Find the end of this key's value (handles single-line values and balanced objects/arrays).
      const valueStart = m.index + m[0].length;
      const end = valueEnd(source, valueStart);
      let text = source;
      let insertAt = lineEnd(text, end);
      // ensure the previous value ends with a comma
      if (!text.slice(end, insertAt).includes(',')) {
        text = `${text.slice(0, end)},${text.slice(end)}`;
        insertAt += 1;
      }
      const needsComma = /^\s*[^\s}]/.test(text.slice(insertAt)) ? ',' : '';
      return `${text.slice(0, insertAt)}${indent}${line}${needsComma}${eol}${text.slice(insertAt)}`;
    }
  }
  const open = rootOpenBrace(source);
  if (open === -1) throw new Error('wrangler config is not a JSON object');
  const rest = source.slice(open + 1);
  if (/^\s*\}/.test(rest)) return `${source.slice(0, open + 1)}${eol}${indent}${line}${eol}${rest.trimStart()}`;
  const newline = /^\r?\n/.test(rest) ? '' : eol;
  return `${source.slice(0, open + 1)}${eol}${indent}${line},${newline}${rest}`;
}

/** End index (exclusive) of a JSON value starting at `start` (string, number, literal, object or array). */
function valueEnd(source: string, start: number): number {
  let i = start;
  const n = source.length;
  while (i < n && /\s/.test(source[i]!)) i++;
  const ch = source[i];
  if (ch === '"') {
    let j = i + 1;
    while (j < n && source[j] !== '"') {
      if (source[j] === '\\') j++;
      j++;
    }
    return j + 1;
  }
  if (ch === '{' || ch === '[') {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = source[j]!;
      if (c === '"') {
        j++;
        while (j < n && source[j] !== '"') {
          if (source[j] === '\\') j++;
          j++;
        }
      } else if (c === '/' && source[j + 1] === '/') {
        while (j < n && source[j] !== '\n') j++;
        continue;
      } else if (c === '/' && source[j + 1] === '*') {
        const end = source.indexOf('*/', j + 2);
        j = end === -1 ? n : end + 2;
        continue;
      } else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return n;
  }
  const m = /^[^,\s}\]]+/.exec(source.slice(i));
  return i + (m?.[0].length ?? 0);
}

/**
 * Applies targeted string edits to a `wrangler.jsonc`/`wrangler.json` document so comments and
 * formatting survive: sets `main`, enables observability and merges cron triggers.
 */
export function editWranglerJsonc(source: string, options: WranglerEditOptions): WranglerEditResult {
  const changes: string[] = [];
  let out = source;

  // main
  const mainMatch = /("main"\s*:\s*)"([^"]*)"/.exec(out);
  if (mainMatch) {
    if (mainMatch[2] !== options.main) {
      out = out.slice(0, mainMatch.index) + `${mainMatch[1]}"${options.main}"` + out.slice(mainMatch.index + mainMatch[0].length);
      changes.push(`main: "${mainMatch[2]}" → "${options.main}"`);
    }
  } else {
    const nameKey = findRootKey(out, 'name');
    out = insertRootLine(out, `"main": "${options.main}"`, nameKey ? 'name' : undefined);
    changes.push(`main: "${options.main}" added`);
  }

  // observability
  if (options.observability !== false) {
    const obs = findRootKey(out, 'observability');
    if (!obs) {
      out = insertRootLine(out, '"observability": { "enabled": true }', 'main');
      changes.push('observability.enabled: true added');
    } else {
      const start = obs.index + obs[0].length;
      const end = valueEnd(out, start);
      const block = out.slice(start, end);
      if (/^\s*\{\s*\}$/.test(block)) {
        out = `${out.slice(0, start)} { "enabled": true }${out.slice(end)}`;
        changes.push('observability.enabled: true set');
      } else if (/"enabled"\s*:\s*false/.test(block)) {
        out = out.slice(0, start) + block.replace(/"enabled"\s*:\s*false/, '"enabled": true') + out.slice(end);
        changes.push('observability.enabled: false → true');
      }
    }
  }

  // crons
  const wanted = [...new Set((options.crons ?? []).map((c) => c.trim()).filter(Boolean))];
  if (wanted.length) {
    const cronsMatch = /("crons"\s*:\s*)(\[[^\]]*\])/.exec(out);
    if (cronsMatch) {
      let existing: string[] = [];
      try {
        existing = (parseJsonc(cronsMatch[2]!) as unknown[]).filter((c): c is string => typeof c === 'string');
      } catch {
        existing = [];
      }
      const missing = wanted.filter((c) => !existing.includes(c));
      if (missing.length) {
        const merged = [...existing, ...missing];
        out = out.slice(0, cronsMatch.index) + `${cronsMatch[1]}${JSON.stringify(merged)}` + out.slice(cronsMatch.index + cronsMatch[0].length);
        changes.push(`triggers.crons: added ${missing.map((c) => `"${c}"`).join(', ')}`);
      }
    } else {
      const triggers = findRootKey(out, 'triggers');
      if (triggers) {
        const start = triggers.index + triggers[0].length;
        const braceAt = out.indexOf('{', start);
        const end = valueEnd(out, start);
        const inner = out.slice(braceAt + 1, end - 1);
        const sep = inner.trim() ? ', ' : ' ';
        out = `${out.slice(0, braceAt + 1)} "crons": ${JSON.stringify(wanted)}${inner.trim() ? `,${inner}` : sep}${out.slice(end - 1)}`;
        changes.push(`triggers.crons: added ${wanted.map((c) => `"${c}"`).join(', ')}`);
      } else {
        out = insertRootLine(out, `"triggers": { "crons": ${JSON.stringify(wanted)} }`, findRootKey(out, 'observability') ? 'observability' : 'main');
        changes.push(`triggers.crons: added ${wanted.map((c) => `"${c}"`).join(', ')}`);
      }
    }
  }

  return { content: out, changes };
}

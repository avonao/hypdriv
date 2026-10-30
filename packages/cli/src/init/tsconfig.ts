import { parseJsonc } from '../wrangler-config';

export interface TsconfigEditResult {
  content: string;
  changed: boolean;
}

/**
 * Adds `entry` to `tsconfig.json#exclude` with a targeted text edit (comments and formatting survive).
 * `hypdriv.worker.ts` imports `./.open-next/worker.js`, which exists only after `opennextjs-cloudflare build`,
 * so the app's `tsc --noEmit` must not include it.
 */
export function addTsconfigExclude(source: string, entry: string): TsconfigEditResult {
  const doc = parseJsonc(source) as { exclude?: unknown };
  if (Array.isArray(doc.exclude) && doc.exclude.some((e) => e === entry || e === `./${entry}`))
    return { content: source, changed: false };
  const match = /("exclude"\s*:\s*\[)([\s\S]*?)(\])/.exec(source);
  if (match) {
    const inner = match[2]!;
    const trimmed = inner.replace(/\s+$/, '');
    const multiline = inner.includes('\n');
    let replacement: string;
    if (!trimmed.trim()) replacement = `"${entry}"`;
    else if (multiline) {
      const indent = /\n([ \t]+)\S/.exec(inner)?.[1] ?? '    ';
      const closingWs = inner.slice(trimmed.length);
      replacement = `${trimmed.replace(/,\s*$/, '')},\n${indent}"${entry}"${closingWs}`;
      return {
        content:
          source.slice(0, match.index) +
          match[1] +
          replacement +
          match[3] +
          source.slice(match.index + match[0].length),
        changed: true,
      };
    } else replacement = `${trimmed.replace(/,\s*$/, '')}, "${entry}"`;
    return {
      content:
        source.slice(0, match.index) +
        match[1] +
        replacement +
        match[3] +
        source.slice(match.index + match[0].length),
      changed: true,
    };
  }
  // No exclude: add one after `include` (or before the final brace).
  const indent = /\n([ \t]+)"/.exec(source)?.[1] ?? '  ';
  const line = `"exclude": ["node_modules", ".open-next", "${entry}"]`;
  const include = /"include"\s*:\s*\[[\s\S]*?\]/.exec(source);
  if (include) {
    const end = include.index + include[0].length;
    return { content: `${source.slice(0, end)},\n${indent}${line}${source.slice(end)}`, changed: true };
  }
  const close = source.lastIndexOf('}');
  const before = source.slice(0, close).replace(/\s+$/, '');
  const needsComma = !before.endsWith('{') && !before.endsWith(',');
  return {
    content: `${before}${needsComma ? ',' : ''}\n${indent}${line}\n${source.slice(close)}`,
    changed: true,
  };
}

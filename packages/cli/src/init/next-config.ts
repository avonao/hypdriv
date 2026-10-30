/**
 * Idempotent, comment-preserving edits to `next.config.*`: adds the `withHypDriv` import and wraps the
 * default export (or `module.exports`). The file is never executed; edits are textual and bracket aware.
 */

export interface WrapResult {
  changed: boolean;
  content: string;
  /** Why nothing changed, or what was done. */
  reason: string;
  /** The default export shape that was wrapped. */
  shape?: 'identifier' | 'object' | 'call' | 'function' | 'class' | 'cjs' | 'other';
}

const STATEMENT_START =
  /^(?:import\b|export\b|const\b|let\b|var\b|function\b|async\s+function\b|class\b|if\b|for\b|while\b|do\b|switch\b|try\b|return\b|throw\b|module\.exports\b|require\s*\(|\/\/|\/\*|@)/;
const CONTINUATION_END = /[,([{+\-*/%&|^?:=.<>!]\s*$/;

/**
 * Finds the end (exclusive) of the expression starting at `start`: the terminating `;` at depth 0 or
 * the point where a new statement begins. Strings, template literals and comments are skipped.
 */
export function scanExpressionEnd(source: string, start: number): number {
  const n = source.length;
  const head = source.slice(start, start + 40);
  const isDeclaration = /^(?:async\s+)?function\b|^class\b/.test(head);
  let depth = 0;
  let sawBody = false;
  let i = start;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    // comments
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      // template literal: scan to the closing backtick, tracking ${ } nesting
      let j = i + 1;
      let inner = 0;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (inner === 0 && c === '`') break;
        if (c === '$' && source[j + 1] === '{') {
          inner++;
          j += 2;
          continue;
        }
        if (inner > 0 && c === '}') inner--;
        if (inner > 0 && c === '{') inner++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (ch === '{') sawBody = true;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      i++;
      if (isDeclaration && ch === '}' && depth === 0 && sawBody) return i;
      continue;
    }
    if (depth === 0) {
      if (ch === ';') return i;
      if (ch === '\n') {
        const before = source.slice(start, i).trimEnd();
        if (!before) {
          i++;
          continue;
        }
        if (CONTINUATION_END.test(before)) {
          i++;
          continue;
        }
        // look at the next non-blank line
        let j = i + 1;
        while (j < n && /\s/.test(source[j]!)) j++;
        if (j >= n) return i;
        const rest = source.slice(j, j + 40);
        if (STATEMENT_START.test(rest)) return i;
        // a line starting with an operator continues the expression
        if (/^[.?:+\-*/&|,)\]}]/.test(rest)) {
          i++;
          continue;
        }
        return i;
      }
    }
    i++;
  }
  return n;
}

function detectQuote(source: string): '"' | "'" {
  const dq = (source.match(/from\s+"/g) ?? []).length + (source.match(/require\("/g) ?? []).length;
  const sq = (source.match(/from\s+'/g) ?? []).length + (source.match(/require\('/g) ?? []).length;
  return dq > sq ? '"' : "'";
}

function detectSemicolons(source: string): boolean {
  const withSemi = (source.match(/;\s*$/gm) ?? []).length;
  const statements = (source.match(/^\s*(?:import|export|const|let|var)\b.*$/gm) ?? []).length;
  return statements === 0 || withSemi >= statements / 2;
}

/** Inserts an import line after the leading import block (or at the top, after directives/comments). */
export function insertImport(source: string, line: string, module: 'esm' | 'cjs'): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  let lastImport = -1;
  let i = 0;
  // skip leading comments / directives
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (
      t === '' ||
      t.startsWith('//') ||
      t.startsWith('/*') ||
      t.startsWith('*') ||
      /^['"]use \w+['"];?$/.test(t)
    ) {
      i++;
      continue;
    }
    break;
  }
  const headerEnd = i;
  const importRe = module === 'esm' ? /^import\b/ : /^(?:const|let|var)\s+.*=\s*require\(/;
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (importRe.test(t)) {
      // multi-line import: advance to the terminating line
      let j = i;
      if (
        module === 'esm' &&
        !/from\s+['"][^'"]+['"];?\s*$/.test(t) &&
        !/^import\s+['"][^'"]+['"];?\s*$/.test(t) &&
        !/^import\s+type\s*\{[^}]*\}\s*from/.test(t)
      ) {
        while (j < lines.length && !/from\s+['"][^'"]+['"];?\s*$/.test(lines[j]!)) j++;
      }
      lastImport = j;
      i = j + 1;
      continue;
    }
    if (t === '' || t.startsWith('//')) {
      i++;
      continue;
    }
    break;
  }
  const insertAt = lastImport >= 0 ? lastImport + 1 : headerEnd;
  lines.splice(insertAt, 0, line);
  return lines.join(eol);
}

/** Adds the `withHypDriv` import and wraps the config export. Safe to call repeatedly. */
export function wrapNextConfig(source: string): WrapResult {
  if (/\bwithHypDriv\s*\(/.test(source))
    return { changed: false, content: source, reason: 'already wrapped in withHypDriv()' };
  const quote = detectQuote(source);
  const semi = detectSemicolons(source) ? ';' : '';
  const esmExport = /export\s+default\s+/.exec(source);
  const cjsExport = /module\.exports\s*=\s*/.exec(source);
  let module: 'esm' | 'cjs';
  let exprStart: number;
  if (esmExport) {
    module = 'esm';
    exprStart = esmExport.index + esmExport[0].length;
  } else if (cjsExport) {
    module = 'cjs';
    exprStart = cjsExport.index + cjsExport[0].length;
  } else {
    return {
      changed: false,
      content: source,
      reason:
        'no `export default` or `module.exports =` found; wrap the config manually: `export default withHypDriv(nextConfig)`',
    };
  }
  const exprEnd = scanExpressionEnd(source, exprStart);
  const expression = source.slice(exprStart, exprEnd).trim();
  if (!expression)
    return { changed: false, content: source, reason: 'empty default export; wrap the config manually' };
  const head = expression.slice(0, 40);
  const shape: WrapResult['shape'] = /^(?:async\s+)?function\b/.test(head)
    ? 'function'
    : /^class\b/.test(head)
      ? 'class'
      : head.startsWith('{')
        ? 'object'
        : /^[A-Za-z_$][\w$.]*\s*\(/.test(head)
          ? 'call'
          : /^[A-Za-z_$][\w$]*$/.test(expression)
            ? 'identifier'
            : module === 'cjs'
              ? 'cjs'
              : 'other';
  const wrapped = `withHypDriv(${source.slice(exprStart, exprEnd).trimEnd()})`;
  let content = source.slice(0, exprStart) + wrapped + source.slice(exprEnd);
  const importLine =
    module === 'esm'
      ? `import { withHypDriv } from ${quote}hypdriv/config${quote}${semi}`
      : `const { withHypDriv } = require(${quote}hypdriv/config${quote})${semi}`;
  const alreadyImported =
    /\bwithHypDriv\b[^\n]*from\s+['"](?:@hypdriv\/next\/config|hypdriv\/config)['"]/.test(content) ||
    /\bwithHypDriv\b[^\n]*require\(['"](?:@hypdriv\/next\/config|hypdriv\/config)['"]\)/.test(content);
  if (!alreadyImported) content = insertImport(content, importLine, module);
  return {
    changed: true,
    content,
    reason: `wrapped the ${shape === 'cjs' ? 'module.exports' : 'default export'} (${shape}) in withHypDriv()`,
    shape,
  };
}

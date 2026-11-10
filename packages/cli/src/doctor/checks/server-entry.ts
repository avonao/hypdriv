import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exists, readJsonFile } from '../../util/fs';
import { maskSource } from './hono';

/**
 * The entry Vercel's zero-config Express or Fastify preset deploys: the first of `app`, `index`, `server` (at the
 * root, then in `src/`) with a JavaScript or TypeScript extension whose source imports the framework. `null` when
 * none does, in which case the preset finds no Function to build.
 */
export function vercelServerEntry(root: string, framework: 'express' | 'fastify'): string | null {
  const imports = new RegExp(`(?:from|require|import)\\s*(?:\\(\\s*)?["']${framework}["']\\s*(?:\\))?`);
  for (const base of ['app', 'index', 'server', 'src/app', 'src/index', 'src/server'])
    for (const ext of ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts']) {
      const file = join(root, `${base}.${ext}`);
      if (!exists(file)) continue;
      try {
        if (imports.test(readFileSync(file, 'utf8'))) return file;
      } catch {
        // unreadable: not an entry Vercel can use either
      }
    }
  return null;
}

/** Whether a source file is loaded as an ES module (`.mjs`/`.mts`, or `"type": "module"` for `.js`/`.ts`). */
export function isEsmFile(root: string, file: string): boolean {
  if (/\.m[jt]s$/.test(file)) return true;
  if (/\.c[jt]s$/.test(file)) return false;
  const pkg = readJsonFile<{ type?: string }>(join(root, 'package.json'));
  return pkg?.type === 'module';
}

/**
 * Relative imports without a file extension (`import app from './app'`). Vercel compiles each file of a Node
 * Function to JavaScript without rewriting import specifiers, and Node's ES module loader does not add extensions,
 * so such an import fails when the Function loads (ERR_MODULE_NOT_FOUND).
 */
export function extensionlessImports(source: string): string[] {
  const code = maskSource(source);
  if (code === null) return [];
  const found: string[] = [];
  // Literals are masked (same length), so the structure is matched on the masked code and the specifier is read
  // back from the original source at the same position.
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"\n]*)\1/gm;
  for (const match of code.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length - (match[2] as string).length - 1;
    const specifier = source.slice(start, start + (match[2] as string).length);
    if (/^\.{1,2}\//.test(specifier) && !/\.(?:[cm]?js|json|node)$/.test(specifier)) found.push(specifier);
  }
  return found;
}

/** `true` when a `listen()` call is awaited at the top level of a module (outside any function body). */
export function awaitsListenAtTopLevel(source: string): boolean {
  const code = maskSource(source);
  if (code === null) return false;
  let depth = 0;
  const pattern = /\bawait\s+[A-Za-z_$][\w$.]*\.listen\s*\(/g;
  const awaited = [...code.matchAll(pattern)].map((m) => m.index ?? 0);
  if (!awaited.length) return false;
  // Depth counted over function bodies only would need a parser; braces approximate it: a top-level `await`
  // outside every block. Object literals (`{ port }`) open and close before the call, so they do not count.
  let next = 0;
  for (let i = 0; i < code.length && next < awaited.length; i++) {
    if (i === awaited[next]) {
      if (depth === 0) return true;
      next += 1;
    }
    const c = code[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return false;
}

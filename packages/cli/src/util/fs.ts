import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Reads a text file or returns null. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parses a JSON file or returns null. */
export function readJsonFile<T = unknown>(file: string): T | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function exists(file: string): boolean {
  return existsSync(file);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Writes text, creating parent directories. */
export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** First existing file among candidates (joined to `dir`), or null. */
export function firstExisting(dir: string, candidates: readonly string[]): string | null {
  for (const c of candidates) {
    const file = join(dir, c);
    if (existsSync(file)) return file;
  }
  return null;
}

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.open-next',
  '.hypdriv',
  '.git',
  '.wrangler',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.vercel',
  '.cache',
]);

export interface WalkOptions {
  /** Directory names skipped at any depth. */
  ignoreDirs?: Set<string>;
  /** File extensions kept (with the dot). Default: all files. */
  extensions?: Set<string>;
  /** Stop after this many files (default 20000). */
  limit?: number;
  maxDepth?: number;
}

/** Lists files below `dir` (absolute paths), skipping build output and dependencies. */
export function walkFiles(dir: string, options: WalkOptions = {}): string[] {
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORED_DIRS;
  const limit = options.limit ?? 20000;
  const maxDepth = options.maxDepth ?? 32;
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        visit(full, depth + 1);
      } else if (e.isFile()) {
        if (options.extensions) {
          const dot = e.name.lastIndexOf('.');
          if (dot === -1 || !options.extensions.has(e.name.slice(dot))) continue;
        }
        out.push(full);
      }
    }
  };
  visit(dir, 0);
  return out;
}

/** Project-relative POSIX path for display. */
export function rel(root: string, file: string): string {
  const r = relative(root, file);
  return (r || '.').split(sep).join('/');
}

/** Detects the indentation used by a JSON/JS file (`'\t'`, `'  '`, `'    '`). */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m?.[1] ?? '  ';
}

/** Detects whether a text uses CRLF line endings. */
export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

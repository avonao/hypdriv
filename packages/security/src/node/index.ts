import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_SECRET_PATTERNS } from '@hypdriv/core';

/** One secret hit in a scanned file. */
export interface SecretFinding {
  /** Pattern id (`stripe-secret`) or `env:<NAME>` for leaked environment values. */
  id: string;
  severity: 'error' | 'warn';
  kind: 'pattern' | 'env';
  /** Path relative to `cwd` (default `process.cwd()`). */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  /** Redacted match: first 4 characters followed by `***`. */
  snippet: string;
  /** Environment variable name for `env` findings. */
  envName?: string;
}

/** Options of `scanSecrets`. */
export interface ScanSecretsOptions {
  /** Directories (or files) to walk. */
  dirs: string[];
  /** Regex patterns; defaults to `DEFAULT_SECRET_PATTERNS` from `@hypdriv/core`. */
  patterns?: Array<{ id: string; pattern: RegExp | string; severity?: 'error' | 'warn' }>;
  /** Pattern ids to skip. */
  ignore?: string[];
  /** Environment to check for leaked values (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Variable name prefixes that are public by design (default `['NEXT_PUBLIC_']`). */
  publicPrefixes?: string[];
  /** Variable names whose values may appear in client code. */
  envAllowlist?: string[];
  /** Minimum env value length to consider (default 12). */
  minValueLength?: number;
  /** File extensions to scan (default `.js .mjs .cjs .css .html .json .txt .map .webmanifest`). */
  extensions?: string[];
  /** Files above this size are skipped (default 10 MiB). */
  maxFileBytes?: number;
  /** Base for relative paths in findings (default `process.cwd()`). */
  cwd?: string;
  /** Directory names never descended into. */
  skipDirs?: string[];
}

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.txt', '.map', '.webmanifest'];
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
const ENV_SKIP_NAMES = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'HOSTNAME',
  'NODE_ENV',
  'NODE_OPTIONS',
  'CI',
  'INIT_CWD',
  'EDITOR',
  'DISPLAY',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'LS_COLORS',
  'SHLVL',
  '_',
]);

/** `true` when an env value is worth searching for (not a path, URL, number, flag or obvious non-secret). */
export function isCandidateEnvValue(
  name: string,
  value: string | undefined,
  options: { publicPrefixes: string[]; allowlist: Set<string>; minLength: number },
): value is string {
  if (!value) return false;
  if (options.allowlist.has(name) || ENV_SKIP_NAMES.has(name)) return false;
  if (
    /^(?:npm_|PNPM_|YARN_|BUN_|GIT_|LESS|LANG|LC_|SSH_|VSCODE_|TERM|GITHUB_|RUNNER_|ACTIONS_|VERCEL_|CF_PAGES|WRANGLER_|CLOUDFLARE_ACCOUNT)/.test(
      name,
    )
  )
    return false;
  if (options.publicPrefixes.some((p) => name.startsWith(p))) return false;
  const v = value.trim();
  if (v.length < options.minLength) return false;
  if (/^(?:true|false|yes|no|on|off|null|undefined|\d+(?:\.\d+)?)$/i.test(v)) return false;
  if (/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)/.test(v)) return false; // file paths
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/:[^/@\s]+@/.test(v)) return false; // URLs without credentials
  if (
    v.includes('/') &&
    v.includes(':') &&
    !v.includes(' ') &&
    /^[^:]+(?::[^:]+)+$/.test(v) &&
    v.split(':').every((p) => p.startsWith('/'))
  )
    return false; // PATH-like
  if (/^\d+\.\d+\.\d+/.test(v)) return false; // versions
  if (/^[a-z]+(?:[-_][a-z]+)*$/i.test(v) && v.length < 24) return false; // plain words / identifiers
  if (/^[a-z_][a-z0-9_]*=/i.test(v)) return false; // key=value blobs
  return true;
}

function redact(match: string): string {
  const head = match.slice(0, 4);
  return `${head}***`;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function position(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo]! + 1 };
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

async function* walk(root: string, extensions: Set<string>, skipDirs: Set<string>): AsyncGenerator<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(root);
  } catch {
    return;
  }
  if (info.isFile()) {
    yield root;
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* walk(full, extensions, skipDirs);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && extensions.has(entry.name.slice(dot).toLowerCase())) yield full;
    }
  }
}

/**
 * Scans build output (client assets) for known secret formats and for the values of non-public
 * environment variables. Skips binary files, files above `maxFileBytes` and symlinks.
 */
export async function scanSecrets(options: ScanSecretsOptions): Promise<SecretFinding[]> {
  const cwd = options.cwd ?? process.cwd();
  const extensions = new Set(
    (options.extensions ?? DEFAULT_EXTENSIONS).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()),
  );
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(options.skipDirs ?? [])]);
  const maxBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  const ignore = new Set(options.ignore ?? []);
  const patterns = (options.patterns ?? DEFAULT_SECRET_PATTERNS)
    .filter((p) => !ignore.has(p.id))
    .map((p) => {
      const source = typeof p.pattern === 'string' ? new RegExp(p.pattern) : p.pattern;
      const flags = source.flags.includes('g') ? source.flags : `${source.flags}g`;
      return { id: p.id, regex: new RegExp(source.source, flags), severity: p.severity ?? 'error' };
    });

  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const envOptions = {
    publicPrefixes: options.publicPrefixes ?? ['NEXT_PUBLIC_'],
    allowlist: new Set(options.envAllowlist ?? []),
    minLength: options.minValueLength ?? 12,
  };
  const envValues: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(env)) {
    if (isCandidateEnvValue(name, value, envOptions)) envValues.push({ name, value: value.trim() });
  }
  // Longest values first so a value that contains another is reported once with the more specific name.
  envValues.sort((a, b) => b.value.length - a.value.length);

  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const push = (f: SecretFinding) => {
    const key = `${f.file}:${f.line}:${f.column}:${f.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const dir of options.dirs) {
    const root = isAbsolute(dir) ? dir : resolve(cwd, dir);
    for await (const file of walk(root, extensions, skipDirs)) {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (info.size > maxBytes || info.size === 0) continue;
      const bytes = new Uint8Array(await readFile(file));
      if (looksBinary(bytes)) continue;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const starts = lineStarts(text);
      const rel = relative(cwd, file) || file;

      for (const p of patterns) {
        p.regex.lastIndex = 0;
        for (const m of text.matchAll(p.regex)) {
          const index = m.index ?? 0;
          const { line, column } = position(starts, index);
          push({
            id: p.id,
            severity: p.severity,
            kind: 'pattern',
            file: rel,
            line,
            column,
            snippet: redact(m[0]),
          });
        }
      }
      for (const { name, value } of envValues) {
        let from = 0;
        for (;;) {
          const index = text.indexOf(value, from);
          if (index === -1) break;
          const { line, column } = position(starts, index);
          push({
            id: `env:${name}`,
            severity: 'error',
            kind: 'env',
            file: rel,
            line,
            column,
            snippet: redact(value),
            envName: name,
          });
          from = index + value.length;
        }
      }
    }
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.id.localeCompare(b.id),
  );
  return findings;
}

/** Formats findings for terminal output (one line per finding plus a summary). */
export function formatFindings(findings: SecretFinding[]): string {
  if (!findings.length) return 'No secrets found.';
  const lines = findings.map((f) => {
    const label = f.kind === 'env' ? `env value of ${f.envName}` : f.id;
    return `${f.severity === 'error' ? 'error' : 'warn '}  ${f.file}:${f.line}:${f.column}  ${label}  ${f.snippet}`;
  });
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.length - errors;
  lines.push(
    '',
    `${findings.length} finding${findings.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'})`,
  );
  return lines.join('\n');
}

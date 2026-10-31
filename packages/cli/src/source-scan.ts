import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exists, isDirectory, rel, walkFiles } from './util/fs';

export interface SourceLocation {
  file: string;
  line: number;
  snippet: string;
}

export interface NodeApiFinding extends SourceLocation {
  /** Module or API name (`child_process`, `fs.watch`, `sharp`, `process.exit`). */
  api: string;
  severity: 'error' | 'warn';
  message: string;
}

export interface EdgeRuntimeFinding extends SourceLocation {
  /** `segment` for `export const runtime = 'edge'`, `pages-config` for `config.runtime = 'edge'`. */
  kind: 'segment' | 'pages-config';
}

export interface SourceScanResult {
  filesScanned: number;
  truncated: boolean;
  edgeRuntime: EdgeRuntimeFinding[];
  nodeApis: NodeApiFinding[];
  /** Uses of Next's cache invalidation and tagging APIs (`revalidateTag`, `revalidatePath`, `'use cache'`, fetch tags…). */
  revalidation: SourceLocation[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

interface ApiRule {
  api: string;
  /** Matches import specifiers / require targets. */
  modules?: string[];
  /** Matches member usage in the file text. */
  pattern?: RegExp;
  severity: 'error' | 'warn';
  message: string;
  /** Skip when this specifier is also imported in the file (e.g. `@cloudflare/puppeteer`). */
  unless?: string[];
}

export const NODE_API_RULES: ApiRule[] = [
  {
    api: 'child_process',
    modules: ['child_process'],
    severity: 'error',
    message:
      'child_process is not available on workerd; move the work to a build step, a Queue consumer or an external service.',
  },
  {
    api: 'worker_threads',
    modules: ['worker_threads'],
    severity: 'error',
    message:
      'worker_threads is not available on workerd; use Durable Objects, Queues or a separate Worker for parallel work.',
  },
  {
    api: 'cluster',
    modules: ['cluster'],
    severity: 'error',
    message: 'cluster is not available on workerd (Workers scale per isolate).',
  },
  {
    api: 'dgram',
    modules: ['dgram'],
    severity: 'error',
    message: 'UDP sockets (dgram) are not available on workerd.',
  },
  {
    api: 'net',
    modules: ['net', 'tls'],
    severity: 'warn',
    message:
      'Only outbound connections (net.connect / connect() from cloudflare:sockets) work on workerd; servers and raw listeners do not.',
  },
  {
    api: 'vm',
    modules: ['vm'],
    severity: 'error',
    message: 'The vm module is not available on workerd (no dynamic code evaluation).',
  },
  {
    api: 'fs.watch',
    pattern: /\b(?:fs\.|fsPromises\.|promises\.)?watch(?:File)?\s*\(/,
    modules: ['fs', 'fs/promises'],
    severity: 'warn',
    message: 'fs.watch has no effect on workerd; the file system is read-only and static at deploy time.',
  },
  {
    api: 'sharp',
    modules: ['sharp'],
    severity: 'error',
    message:
      'sharp (native) cannot run on workerd; use the Images binding or next/image through the Cloudflare loader.',
  },
  {
    api: 'canvas',
    modules: ['canvas', '@napi-rs/canvas', 'skia-canvas'],
    severity: 'error',
    message:
      'Native canvas packages cannot run on workerd; use @vercel/og / satori-based rendering or an external service.',
  },
  {
    api: 'bcrypt',
    modules: ['bcrypt'],
    severity: 'error',
    message:
      'bcrypt (native) cannot run on workerd; use passwords.hash() from @hypdriv/security (scrypt/PBKDF2) or bcryptjs.',
  },
  {
    api: 'puppeteer',
    modules: ['puppeteer', 'puppeteer-core', 'playwright', 'playwright-core'],
    unless: ['@cloudflare/puppeteer', '@cloudflare/playwright'],
    severity: 'error',
    message:
      'Headless browsers need Browser Rendering (@cloudflare/puppeteer or @cloudflare/playwright) on Workers.',
  },
  {
    api: 'process.exit',
    pattern: /\bprocess\.exit\s*\(/,
    severity: 'warn',
    message: 'process.exit() terminates nothing on workerd and masks errors; throw instead.',
  },
];

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** Import specifiers referenced by a file (static, dynamic and require). */
export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(IMPORT_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

function normalizeModule(spec: string): string {
  return spec.startsWith('node:') ? spec.slice(5) : spec;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function snippetAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  let end = source.indexOf('\n', index);
  if (end === -1) end = source.length;
  return source.slice(start, end).trim().slice(0, 160);
}

/** Finds unsupported Node API usage in one file. */
export function scanNodeApis(file: string, source: string, root: string): NodeApiFinding[] {
  const findings: NodeApiFinding[] = [];
  const specs = importSpecifiers(source);
  const normalized = specs.map(normalizeModule);
  const display = rel(root, file);
  for (const rule of NODE_API_RULES) {
    if (rule.unless?.some((u) => normalized.includes(u))) continue;
    if (rule.modules && !rule.pattern) {
      for (const spec of specs) {
        const base = normalizeModule(spec);
        const moduleName = base.split('/')[0]!.startsWith('@')
          ? base.split('/').slice(0, 2).join('/')
          : base.split('/')[0]!;
        if (!rule.modules.includes(base) && !rule.modules.includes(moduleName)) continue;
        const idx = source.indexOf(spec);
        findings.push({
          file: display,
          line: lineOf(source, idx),
          snippet: snippetAt(source, idx),
          api: rule.api,
          severity: rule.severity,
          message: rule.message,
        });
        break;
      }
      continue;
    }
    if (rule.pattern) {
      if (rule.modules && !specs.some((s) => rule.modules!.includes(normalizeModule(s)))) continue;
      const re = new RegExp(rule.pattern.source, 'g');
      const m = re.exec(source);
      if (m) {
        findings.push({
          file: display,
          line: lineOf(source, m.index),
          snippet: snippetAt(source, m.index),
          api: rule.api,
          severity: rule.severity,
          message: rule.message,
        });
      }
    }
  }
  return findings;
}

const EDGE_SEGMENT_RE = /export\s+const\s+runtime\s*(?::\s*[^=]+)?=\s*['"]edge['"]/g;
const EDGE_PAGES_RE =
  /export\s+const\s+config\s*(?::\s*[^=]+)?=\s*\{[^}]*runtime\s*:\s*['"](?:edge|experimental-edge)['"]/g;

/** Finds Edge runtime declarations in a route file. */
const REVALIDATION_RE =
  /\b(?:revalidateTag|revalidatePath|updateTag|unstable_cache|cacheTag|cacheLife)\s*\(|^\s*['"]use cache(?::\s*\w+)?['"]|\bnext\s*:\s*\{[^}]*\b(?:tags|revalidate)\s*:/gm;

/** Calls that need the OpenNext tag cache (and, for time-based revalidation, its queue) to do anything on Cloudflare. */
export function scanRevalidation(file: string, source: string, root: string): SourceLocation[] {
  const display = rel(root, file);
  return [...source.matchAll(REVALIDATION_RE)].map((m) => ({
    file: display,
    line: lineOf(source, m.index),
    snippet: snippetAt(source, m.index),
  }));
}

export function scanEdgeRuntime(file: string, source: string, root: string): EdgeRuntimeFinding[] {
  const out: EdgeRuntimeFinding[] = [];
  const display = rel(root, file);
  for (const m of source.matchAll(EDGE_SEGMENT_RE))
    out.push({
      file: display,
      line: lineOf(source, m.index),
      snippet: snippetAt(source, m.index),
      kind: 'segment',
    });
  for (const m of source.matchAll(EDGE_PAGES_RE))
    out.push({
      file: display,
      line: lineOf(source, m.index),
      snippet: snippetAt(source, m.index),
      kind: 'pages-config',
    });
  return out;
}

/** Candidate source directories of a Next.js project. */
export function sourceDirs(root: string): string[] {
  const dirs = [
    'app',
    'pages',
    'src',
    'components',
    'lib',
    'server',
    'utils',
    'hooks',
    'proxy.ts',
    'middleware.ts',
    'instrumentation.ts',
  ];
  return dirs.map((d) => join(root, d)).filter((p) => exists(p));
}

export interface ScanOptions {
  limit?: number;
}

/** Scans the application sources once; results feed several doctor checks. */
export function scanSources(root: string, options: ScanOptions = {}): SourceScanResult {
  const limit = options.limit ?? 5000;
  const files: string[] = [];
  for (const dir of sourceDirs(root)) {
    if (isDirectory(dir))
      files.push(...walkFiles(dir, { extensions: SOURCE_EXTENSIONS, limit: limit - files.length }));
    else files.push(dir);
    if (files.length >= limit) break;
  }
  const result: SourceScanResult = {
    filesScanned: 0,
    truncated: files.length >= limit,
    edgeRuntime: [],
    nodeApis: [],
    revalidation: [],
  };
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    result.filesScanned++;
    if (source.length > 2_000_000) continue;
    const isRouteFile =
      /[\\/](?:app|pages|src[\\/]app|src[\\/]pages)[\\/]/.test(file) || /[\\/](?:app|pages)$/.test(file);
    if (
      isRouteFile ||
      /[\\/]proxy\.[cm]?[jt]sx?$/.test(file) ||
      /[\\/]middleware\.[cm]?[jt]sx?$/.test(file)
    ) {
      result.edgeRuntime.push(...scanEdgeRuntime(file, source, root));
    }
    if (/\.d\.ts$/.test(file) || /\.test\.|\.spec\./.test(file)) continue;
    result.nodeApis.push(...scanNodeApis(file, source, root));
    result.revalidation.push(...scanRevalidation(file, source, root));
  }
  return result;
}

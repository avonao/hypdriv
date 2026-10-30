import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readJsonFile } from '../util/fs';
import { VERCEL_EDGE_LIMITS, VERCEL_FUNCTION_LIMIT } from '../vercel-config';
import { packageOf } from './packages';

/** `.vc-config.json` fields HypDriv reads (Build Output API v3). */
export interface VcConfig {
  runtime?: string;
  handler?: string;
  entrypoint?: string;
  launcherType?: string;
  regions?: string[];
  maxDuration?: number;
  memory?: number;
  operationType?: string;
  framework?: { slug?: string; version?: string };
  /** Output path → source path (relative to the build root) for traced files not copied into the function. */
  filePathMap?: Record<string, string>;
}

export interface VercelFunctionReport {
  /** Function directory relative to `.vercel/output/functions`, without `.func` (e.g. `blog/[slug]`). */
  name: string;
  /** Routes served by this function (symlinked `.func` directories collapse into one entry). */
  routes: string[];
  runtime: string;
  kind: 'node' | 'edge' | 'other';
  regions: string[];
  maxDuration: number | null;
  memory: number | null;
  files: number;
  /** Uncompressed bytes (files in the `.func` directory plus `filePathMap` sources). */
  bytes: number;
  /** Gzip size (edge functions only; their limit is on the compressed size). */
  gzip: number | null;
  /** Fraction of the applicable limit. */
  share: number;
  limit: number;
  status: 'ok' | 'warn' | 'error';
  topPackages: Array<{ name: string; bytes: number }>;
  missingFiles: number;
}

export interface VercelAnalysis {
  outputDir: string;
  functions: VercelFunctionReport[];
  static: { files: number; bytes: number };
  /** Function limit used for Node.js functions (250 MB uncompressed). */
  limit: number;
  largest: VercelFunctionReport | null;
  config: { version?: number; crons?: Array<{ path: string; schedule: string }> } | null;
}

function walk(dir: string, visit: (file: string, size: number) => void, seen = new Set<string>()): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    let st: import('node:fs').Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, visit, seen);
    else if (st.isFile()) visit(full, st.size);
  }
}

/** Lists `.func` directories below `functions/` (relative names, `.func` stripped). */
export function listFunctionDirs(functionsDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const relName = prefix ? `${prefix}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      if (e.name.endsWith('.func')) out.push(relName.slice(0, -'.func'.length));
      else visit(full, relName);
    }
  };
  visit(functionsDir, '');
  return out.sort();
}

function routeOf(name: string): string {
  const route = `/${name}`.replace(/\.(?:rsc|prefetch\.rsc)$/, '').replace(/\/index$/, '/');
  return route === '' ? '/' : route;
}

/**
 * Measures every function of a Build Output API directory (`.vercel/output`) against Vercel's limits:
 * 250 MB uncompressed for Node.js functions (files in the `.func` directory plus traced files from
 * `filePathMap`), and the gzip limits for Edge functions.
 */
export function analyzeVercelOutput(
  outputDir: string,
  options: { buildRoot: string; edgeLimit?: number },
): VercelAnalysis {
  const functionsDir = join(outputDir, 'functions');
  const byReal = new Map<string, VercelFunctionReport>();
  for (const name of listFunctionDirs(functionsDir)) {
    const dir = join(functionsDir, `${name}.func`);
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    const existing = byReal.get(real);
    if (existing) {
      existing.routes.push(routeOf(name));
      continue;
    }
    const isLink = (() => {
      try {
        return lstatSync(dir).isSymbolicLink();
      } catch {
        return false;
      }
    })();
    const vc = readJsonFile<VcConfig>(join(dir, '.vc-config.json')) ?? {};
    const runtime = vc.runtime ?? 'unknown';
    const kind: VercelFunctionReport['kind'] =
      runtime === 'edge' ? 'edge' : runtime.startsWith('nodejs') ? 'node' : 'other';
    const files = new Map<string, number>();
    const packages = new Map<string, number>();
    const add = (file: string, size: number, display: string) => {
      let key = file;
      try {
        key = realpathSync(file);
      } catch {
        // keep path
      }
      if (files.has(key)) return;
      files.set(key, size);
      const pkg = packageOf(display);
      if (pkg) packages.set(pkg.name, (packages.get(pkg.name) ?? 0) + size);
    };
    walk(dir, (file, size) => add(file, size, relative(dir, file).split(sep).join('/')));
    let missingFiles = 0;
    for (const source of Object.values(vc.filePathMap ?? {})) {
      const candidates = isAbsolute(source) ? [source] : [join(options.buildRoot, source)];
      const found = candidates.find((c) => {
        try {
          return statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!found) {
        missingFiles++;
        continue;
      }
      add(found, statSync(found).size, source);
    }
    const bytes = [...files.values()].reduce((n, b) => n + b, 0);
    let gzip: number | null = null;
    let limit = VERCEL_FUNCTION_LIMIT;
    let share = bytes / VERCEL_FUNCTION_LIMIT;
    if (kind === 'edge') {
      let compressed = 0;
      for (const file of files.keys()) {
        try {
          compressed += gzipSync(readFileSync(file), { level: 6 }).length;
        } catch {
          // unreadable file
        }
      }
      gzip = compressed;
      limit = options.edgeLimit ?? VERCEL_EDGE_LIMITS.hobby;
      share = compressed / limit;
    }
    const status: VercelFunctionReport['status'] =
      kind === 'edge'
        ? gzip! > VERCEL_EDGE_LIMITS.enterprise
          ? 'error'
          : share > 1
            ? 'warn'
            : 'ok'
        : share > 1
          ? 'error'
          : share > 0.8
            ? 'warn'
            : 'ok';
    byReal.set(real, {
      name: isLink
        ? relative(functionsDir, real)
            .split(sep)
            .join('/')
            .replace(/\.func$/, '')
        : name,
      routes: [routeOf(name)],
      runtime,
      kind,
      regions: vc.regions ?? [],
      maxDuration: vc.maxDuration ?? null,
      memory: vc.memory ?? null,
      files: files.size,
      bytes,
      gzip,
      share,
      limit,
      status,
      topPackages: [...packages.entries()]
        .map(([n, b]) => ({ name: n, bytes: b }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5),
      missingFiles,
    });
  }
  const functions = [...byReal.values()].sort((a, b) => b.bytes - a.bytes);
  for (const f of functions) f.routes = [...new Set(f.routes)].sort();
  const stat = { files: 0, bytes: 0 };
  walk(join(outputDir, 'static'), (_file, size) => {
    stat.files++;
    stat.bytes += size;
  });
  const config = readJsonFile<VercelAnalysis['config']>(join(outputDir, 'config.json'));
  return {
    outputDir,
    functions,
    static: stat,
    limit: VERCEL_FUNCTION_LIMIT,
    largest: functions.find((f) => f.kind === 'node') ?? functions[0] ?? null,
    config,
  };
}

import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BudgetResult, HypManifest, WorkerWeight } from '@hypdriv/core';
import { readJsonFile, writeText } from '../util/fs';
import type { MetafileSummary } from './metafile';
import { aggregatePackages } from './packages';
import { attributeBytes, type SourceMapV3, sourcePath } from './sourcemap';

export const ANALYZE_FILE = '.hypdriv/analyze.json';
/** Cloudflare's uncompressed Worker size limit. */
export const WORKER_SIZE_LIMIT = 64 * 1024 * 1024;

export interface WorkerAnalysis extends WorkerWeight {
  /** Bytes not attributable to any source (glue, whitespace). */
  unmapped: number;
  /** Application (non node_modules) bytes. */
  appBytes: number;
  /** Numbers printed by `wrangler deploy --dry-run`, when they were captured. */
  wranglerReported: { total: number; gzip: number } | null;
  metafile: MetafileSummary | null;
}

export interface AnalyzeSnapshot {
  version: 1;
  generatedAt: string;
  buildId: string | null;
  worker: WorkerAnalysis | null;
  routes: Array<{ id: string; pathname: string; classification: string; js: number; css: number }>;
  budgets: BudgetResult[];
}

/** Gzip size at level 6 (what CDNs typically apply). */
export function gzipSize(input: string | Uint8Array): number {
  return gzipSync(input, { level: 6 }).length;
}

/**
 * Counts `await` tokens outside any function or block in the first `limit` bytes of a bundle: a proxy
 * for top-level work that runs during the Worker's 1 s global-scope budget. Strings, template
 * literals and comments are skipped; braces track nesting.
 */
export function countTopLevelAwaits(code: string, limit = 200_000): number {
  const text = code.length > limit ? code.slice(0, limit) : code;
  const n = text.length;
  let depth = 0;
  let count = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let inner = 0;
      while (j < n) {
        const c = text[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (inner === 0 && c === '`') break;
        if (c === '$' && text[j + 1] === '{') {
          inner++;
          j += 2;
          continue;
        }
        if (inner > 0 && c === '}') inner--;
        else if (inner > 0 && c === '{') inner++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && ch === 'a' && text.startsWith('await', i)) {
      const before = i === 0 ? '' : text[i - 1]!;
      const after = text[i + 5] ?? '';
      if (!/[\w$.]/.test(before) && !/[\w$]/.test(after)) count++;
      i += 5;
      continue;
    }
    i++;
  }
  return count;
}

export interface AnalyzeBundleInput {
  file: string;
  code: string;
  map: SourceMapV3 | null;
  wranglerReported?: { total: number; gzip: number } | null;
  metafile?: MetafileSummary | null;
  topModules?: number;
  topPackages?: number;
}

/** Measures a Worker bundle and attributes it to modules and packages. */
export function analyzeWorkerBundle(input: AnalyzeBundleInput): WorkerAnalysis {
  const raw = Buffer.byteLength(input.code);
  const gzip = gzipSize(input.code);
  const topLevelAwaits = countTopLevelAwaits(input.code);
  if (!input.map) {
    return {
      file: input.file,
      raw,
      gzip,
      topLevelAwaits,
      largestModules: [],
      byPackage: [],
      duplicates: [],
      sourceMap: false,
      unmapped: raw,
      appBytes: 0,
      wranglerReported: input.wranglerReported ?? null,
      metafile: input.metafile ?? null,
    };
  }
  const attribution = attributeBytes(input.code, input.map);
  const entries = [...attribution.bySource.entries()].map(([index, bytes]) => ({ source: sourcePath(input.map!, index), bytes }));
  const largestModules = [...entries]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, input.topModules ?? 25)
    .map((e) => ({ source: e.source, bytes: e.bytes, share: raw ? e.bytes / raw : 0 }));
  const packages = aggregatePackages(entries, raw);
  return {
    file: input.file,
    raw,
    gzip,
    topLevelAwaits,
    largestModules,
    byPackage: packages.byPackage.slice(0, input.topPackages ?? 15),
    duplicates: packages.duplicates,
    sourceMap: true,
    unmapped: attribution.unmapped + Math.max(0, raw - attribution.total),
    appBytes: packages.appBytes,
    wranglerReported: input.wranglerReported ?? null,
    metafile: input.metafile ?? null,
  };
}

/** Parses the size summary wrangler prints (`Total Upload: 1234.56 KiB / gzip: 345.67 KiB`). */
export function parseWranglerSizes(output: string): { total: number; gzip: number } | null {
  const m = /Total Upload:\s*([\d.,]+)\s*(B|KiB|MiB|GiB)\s*\/\s*gzip:\s*([\d.,]+)\s*(B|KiB|MiB|GiB)/i.exec(output);
  if (!m) return null;
  const unit = (u: string) => (u === 'B' ? 1 : u === 'KiB' ? 1024 : u === 'MiB' ? 1024 ** 2 : 1024 ** 3);
  const num = (s: string) => Number(s.replace(/,/g, ''));
  return { total: Math.round(num(m[1]!) * unit(m[2]!)), gzip: Math.round(num(m[3]!) * unit(m[4]!)) };
}

/** Route rows from the manifest (pages only). */
export function routeWeights(manifest: HypManifest): AnalyzeSnapshot['routes'] {
  return manifest.routes
    .filter((r) => r.kind === 'app-page' || r.kind === 'page')
    .map((r) => ({
      id: r.id,
      pathname: r.pathname,
      classification: r.classification,
      js: manifest.weights.client[r.id]?.js ?? 0,
      css: manifest.weights.client[r.id]?.css ?? 0,
    }));
}

export function readAnalyzeSnapshot(root: string): AnalyzeSnapshot | null {
  const snap = readJsonFile<AnalyzeSnapshot>(join(root, ANALYZE_FILE));
  return snap && snap.version === 1 ? snap : null;
}

export function writeAnalyzeSnapshot(root: string, snapshot: AnalyzeSnapshot): string {
  const file = join(root, ANALYZE_FILE);
  writeText(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

/** The `WorkerWeight` subset stored in the manifest. */
export function toWorkerWeight(analysis: WorkerAnalysis): WorkerWeight {
  return {
    file: analysis.file,
    raw: analysis.raw,
    gzip: analysis.gzip,
    topLevelAwaits: analysis.topLevelAwaits,
    largestModules: analysis.largestModules,
    byPackage: analysis.byPackage,
    duplicates: analysis.duplicates,
    sourceMap: analysis.sourceMap,
  };
}

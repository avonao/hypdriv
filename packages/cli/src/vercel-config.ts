import { parseJsonc } from './wrangler-config';

/** One Vercel Cron entry (`vercel.json#crons`). */
export interface VercelCron {
  path: string;
  schedule: string;
}

/** The subset of `vercel.json` / `vercel.ts` HypDriv inspects. */
export interface VercelConfig {
  crons: VercelCron[];
  /** Top-level function regions (`["iad1"]`). */
  regions: string[];
  /** Per-pattern function settings. */
  functions: Record<string, { maxDuration?: number; memory?: number; regions?: string[]; runtime?: string }>;
  framework: string | null;
  buildCommand: string | null;
  /** `true` when values come from a static read of `vercel.ts` (best effort). */
  approximate: boolean;
  raw: Record<string, unknown>;
}

/** US regions, in the order HypDriv recommends them (US-first default: `iad1`). */
export const VERCEL_US_REGIONS = ['iad1', 'cle1', 'pdx1', 'sfo1'];
export const VERCEL_DEFAULT_REGION = 'iad1';
/** Vercel Functions: maximum uncompressed bundle size, layers included. */
export const VERCEL_FUNCTION_LIMIT = 250 * 1000 * 1000;
/** Vercel Edge Functions: gzip size limits per plan (Hobby / Pro / Enterprise). */
export const VERCEL_EDGE_LIMITS = { hobby: 1024 * 1024, pro: 2 * 1024 * 1024, enterprise: 4 * 1024 * 1024 };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Normalises a parsed `vercel.json` document. */
export function normalizeVercelConfig(doc: Record<string, unknown>, approximate = false): VercelConfig {
  const crons: VercelCron[] = Array.isArray(doc.crons)
    ? (doc.crons as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .filter((c) => typeof c.path === 'string' && typeof c.schedule === 'string')
        .map((c) => ({ path: c.path as string, schedule: c.schedule as string }))
    : [];
  const functions: VercelConfig['functions'] = {};
  if (doc.functions && typeof doc.functions === 'object') {
    for (const [pattern, value] of Object.entries(doc.functions as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      functions[pattern] = {
        ...(typeof v.maxDuration === 'number' ? { maxDuration: v.maxDuration } : {}),
        ...(typeof v.memory === 'number' ? { memory: v.memory } : {}),
        ...(Array.isArray(v.regions) ? { regions: strings(v.regions) } : {}),
        ...(typeof v.runtime === 'string' ? { runtime: v.runtime } : {}),
      };
    }
  }
  return {
    crons,
    regions: strings(doc.regions),
    functions,
    framework: typeof doc.framework === 'string' ? doc.framework : null,
    buildCommand: typeof doc.buildCommand === 'string' ? doc.buildCommand : null,
    approximate,
    raw: doc,
  };
}

/** Parses `vercel.json` text (JSON; comments tolerated). */
export function parseVercelJson(text: string): VercelConfig {
  const doc = parseJsonc(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    throw new SyntaxError('vercel.json must be an object');
  return normalizeVercelConfig(doc as Record<string, unknown>);
}

/**
 * Best-effort static read of `vercel.ts` (`@vercel/config`): extracts literal `crons`, `regions` and
 * `framework` values without executing the file.
 */
export function readVercelTs(source: string): VercelConfig {
  const crons: VercelCron[] = [];
  const cronBlock = /crons\s*:\s*\[([\s\S]*?)\]\s*[,}]/.exec(source)?.[1] ?? '';
  for (const m of cronBlock.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]!;
    const path = /path\s*:\s*['"`]([^'"`]+)['"`]/.exec(body)?.[1];
    const schedule = /schedule\s*:\s*['"`]([^'"`]+)['"`]/.exec(body)?.[1];
    if (path && schedule) crons.push({ path, schedule });
  }
  // routes.cron('/path', 'schedule') helper form
  for (const m of source.matchAll(/cron\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/g))
    crons.push({ path: m[1]!, schedule: m[2]! });
  const regionsBlock = /\bregions\s*:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  const regions = [...regionsBlock.matchAll(/['"`]([a-z0-9]+)['"`]/g)].map((m) => m[1]!);
  const framework = /\bframework\s*:\s*['"`]([^'"`]+)['"`]/.exec(source)?.[1] ?? null;
  return { crons, regions, functions: {}, framework, buildCommand: null, approximate: true, raw: {} };
}

/** Whether a region code is in the United States. */
export function isUsRegion(region: string): boolean {
  return VERCEL_US_REGIONS.includes(region);
}

export interface VercelCronEditResult {
  content: string;
  changes: string[];
}

/** Adds missing crons to a `vercel.json` text (or creates the document); keeps unrelated keys and indentation. */
export function upsertVercelCrons(source: string | null, crons: VercelCron[]): VercelCronEditResult {
  const doc: Record<string, unknown> = source
    ? (parseJsonc(source) as Record<string, unknown>)
    : { $schema: 'https://openapi.vercel.sh/vercel.json' };
  const existing = Array.isArray(doc.crons) ? (doc.crons as VercelCron[]) : [];
  const changes: string[] = [];
  const merged = [...existing];
  for (const cron of crons) {
    const same = merged.find((c) => c.path === cron.path);
    if (!same) {
      merged.push(cron);
      changes.push(`crons: added ${cron.path} (${cron.schedule})`);
    } else if (same.schedule !== cron.schedule) {
      changes.push(`crons: ${cron.path} schedule "${same.schedule}" → "${cron.schedule}"`);
      same.schedule = cron.schedule;
    }
  }
  if (!changes.length && source) return { content: source, changes };
  doc.crons = merged;
  const indent = source ? (/\n([ \t]+)"/.exec(source)?.[1] ?? '  ') : '  ';
  return {
    content: `${JSON.stringify(doc, null, indent)}\n`,
    changes: source ? changes : ['vercel.json created', ...changes],
  };
}

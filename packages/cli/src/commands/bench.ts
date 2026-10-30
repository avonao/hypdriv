import { UsageError } from '../args';
import { cacheStatus } from '../audit/cache';
import { fetchTtfb, joinUrl, mapConcurrent, normalizeBaseUrl, percentile } from '../audit/http';
import { choosePaths } from '../audit/paths';
import { auditAuth, describeAuditAuth } from '../audit/token';
import { createContext } from '../context';
import { millis } from '../ui';
import { defineCommand } from './types';

export interface BenchPathResult {
  path: string;
  n: number;
  ttfb: { p50: number; p95: number; max: number; min: number; mean: number };
  total: { p50: number; p95: number };
  statuses: Record<string, number>;
  cache: Record<string, number>;
  errors: number;
}

/** Aggregates samples for one path. */
export function summarizeSamples(
  path: string,
  samples: Array<{
    status: number;
    ttfbMs: number;
    totalMs: number;
    cache: string | null;
    error: string | null;
  }>,
): BenchPathResult {
  const ok = samples.filter((s) => !s.error);
  const ttfbs = ok.map((s) => s.ttfbMs);
  const totals = ok.map((s) => s.totalMs);
  const statuses: Record<string, number> = {};
  const cache: Record<string, number> = {};
  for (const s of samples) {
    const key = s.error ? 'error' : String(s.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
    if (!s.error) {
      const c = s.cache ?? 'none';
      cache[c] = (cache[c] ?? 0) + 1;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    path,
    n: samples.length,
    ttfb: {
      p50: round(percentile(ttfbs, 50)),
      p95: round(percentile(ttfbs, 95)),
      max: round(ttfbs.length ? Math.max(...ttfbs) : 0),
      min: round(ttfbs.length ? Math.min(...ttfbs) : 0),
      mean: round(ttfbs.length ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length : 0),
    },
    total: { p50: round(percentile(totals, 50)), p95: round(percentile(totals, 95)) },
    statuses,
    cache,
    errors: samples.length - ok.length,
  };
}

export const benchCommand = defineCommand({
  name: 'bench',
  summary: 'TTFB p50/p95/max, status and cache-status distribution per path against a running server',
  usage: 'hypdriv bench --url <base> [--paths a,b] [--n 20] [--concurrency 4] [--warmup 1]',
  options: {
    url: { type: 'string', value: '<base>', description: 'Base URL' },
    paths: {
      type: 'string',
      value: '<a,b>',
      description: 'Paths (default: from the manifest)',
      multiple: true,
    },
    n: { type: 'string', value: '<n>', description: 'Requests per path', default: '20' },
    concurrency: { type: 'string', value: '<n>', description: 'Parallel requests per path', default: '4' },
    warmup: { type: 'string', value: '<n>', description: 'Unmeasured requests per path first', default: '1' },
    limit: { type: 'string', value: '<n>', description: 'Maximum manifest paths', default: '10' },
    timeout: { type: 'string', value: '<ms>', description: 'Per-request timeout', default: '10000' },
    anonymous: {
      type: 'boolean',
      description: 'Send unsigned requests (no x-hypdriv-audit token), as an anonymous visitor would',
    },
  },
  examples: [
    'hypdriv bench --url http://localhost:8787',
    'hypdriv bench --url https://www.example.com --paths /,/blog --n 50 --json',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required');
    const n = args.number('n', 20, { min: 1, max: 10_000 });
    const concurrency = args.number('concurrency', 4, { min: 1, max: 64 });
    const warmup = args.number('warmup', 1, { min: 0, max: 100 });
    const timeoutMs = args.number('timeout', 10_000, { min: 100 });
    const paths = choosePaths(ctx.manifest(), {
      paths: args.list('paths'),
      limit: args.number('limit', 10, { min: 1 }),
    }).map((p) => p.path);
    let secretName = 'HYPDRIV_INTERNAL_SECRET';
    try {
      secretName = (await ctx.loadConfig()).resolved.security.internalAuth.secretEnv;
    } catch {
      // bench works without a HypDriv config (any Next.js deployment); keep the default variable name.
    }
    const auth = await auditAuth({
      root: ctx.root,
      io,
      base,
      secretName,
      anonymous: args.boolean('anonymous'),
    });
    const opts = { fetch: io.fetch, timeoutMs, headers: auth.headers };
    if (!args.json) {
      ui.heading(`Benchmark ${base} · ${paths.length} path(s) × ${n} requests · concurrency ${concurrency}`);
      ui.note(describeAuditAuth(auth));
    }
    const results: BenchPathResult[] = [];
    for (const path of paths) {
      const url = joinUrl(base, path);
      for (let i = 0; i < warmup; i++) await fetchTtfb(url, opts, io.now);
      const samples = await mapConcurrent(
        Array.from({ length: n }, (_, i) => i),
        concurrency,
        async () => {
          const r = await fetchTtfb(url, opts, io.now);
          return {
            status: r.status,
            ttfbMs: r.ttfbMs,
            totalMs: r.totalMs,
            cache: cacheStatus(r.headers),
            error: r.error,
          };
        },
      );
      results.push(summarizeSamples(path, samples));
    }
    const errors = results.reduce((s, r) => s + r.errors, 0);
    if (args.json) {
      ui.printJson({ url: base, n, concurrency, results });
      return errors ? 1 : 0;
    }
    ui.table(
      results.map((r) => [
        r.path,
        millis(r.ttfb.p50),
        millis(r.ttfb.p95),
        millis(r.ttfb.max),
        Object.entries(r.statuses)
          .map(([k, v]) => `${k}×${v}`)
          .join(' '),
        Object.entries(r.cache)
          .map(([k, v]) => `${k}×${v}`)
          .join(' '),
      ]),
      {
        columns: [
          'path',
          { header: 'p50', align: 'right' },
          { header: 'p95', align: 'right' },
          { header: 'max', align: 'right' },
          'status',
          'cache',
        ],
      },
    );
    if (errors) ui.warn(`${errors} request(s) failed (timeouts or connection errors).`);
    return errors ? 1 : 0;
  },
});

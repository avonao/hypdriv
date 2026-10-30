import type { ResolvedBudgets } from './config/resolved';
import type { BudgetResult, HypManifest } from './manifest/types';
import { matchesAny } from './util/pattern';
import { formatBytes } from './util/units';

export interface BudgetInput {
  routes: Array<{ id: string; pathname: string; js: number; css: number; html?: number }>;
  worker?: { raw: number; gzip: number; startupMs?: number };
  totalJs?: number;
}

/** Evaluates budgets against measured sizes. `warn` threshold is 90% of the limit. */
export function evaluateBudgets(budgets: ResolvedBudgets, input: BudgetInput): BudgetResult[] {
  const out: BudgetResult[] = [];
  const status = (actual: number, limit: number): BudgetResult['status'] =>
    actual > limit ? 'error' : actual > limit * 0.9 ? 'warn' : 'ok';

  for (const [pattern, limits] of Object.entries(budgets.routes)) {
    for (const route of input.routes) {
      if (!matchesAny(pattern, route.pathname)) continue;
      for (const metric of ['js', 'css', 'html'] as const) {
        const limit = limits[metric];
        const actual = route[metric];
        if (limit === null || actual === undefined) continue;
        out.push({
          id: `route:${route.id}:${metric}`,
          scope: 'route',
          metric,
          limit,
          actual,
          status: status(actual, limit),
          target: route.pathname,
        });
      }
    }
  }
  if (input.worker) {
    if (budgets.worker.raw !== null)
      out.push({
        id: 'worker:raw',
        scope: 'worker',
        metric: 'raw',
        limit: budgets.worker.raw,
        actual: input.worker.raw,
        status: status(input.worker.raw, budgets.worker.raw),
      });
    if (budgets.worker.gzip !== null)
      out.push({
        id: 'worker:gzip',
        scope: 'worker',
        metric: 'gzip',
        limit: budgets.worker.gzip,
        actual: input.worker.gzip,
        status: status(input.worker.gzip, budgets.worker.gzip),
      });
    if (budgets.worker.startupMs !== null && input.worker.startupMs !== undefined) {
      out.push({
        id: 'worker:startup',
        scope: 'worker',
        metric: 'startupMs',
        limit: budgets.worker.startupMs,
        actual: input.worker.startupMs,
        status: status(input.worker.startupMs, budgets.worker.startupMs),
      });
    }
  }
  if (budgets.totalJs !== null && input.totalJs !== undefined) {
    out.push({
      id: 'total:js',
      scope: 'total',
      metric: 'js',
      limit: budgets.totalJs,
      actual: input.totalJs,
      status: status(input.totalJs, budgets.totalJs),
    });
  }
  return out;
}

/** Overall outcome considering `failOn`. */
export function budgetsOutcome(results: BudgetResult[], failOn: ResolvedBudgets['failOn']): 'pass' | 'fail' {
  if (failOn === 'never') return 'pass';
  if (results.some((r) => r.status === 'error')) return 'fail';
  if (failOn === 'warn' && results.some((r) => r.status === 'warn')) return 'pass';
  return 'pass';
}

export function formatBudgetResult(r: BudgetResult): string {
  const fmt = r.metric === 'startupMs' ? (n: number) => `${n} ms` : formatBytes;
  const icon = r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'OVER';
  return `${icon.padEnd(4)} ${r.id}${r.target ? ` (${r.target})` : ''}: ${fmt(r.actual)} / ${fmt(r.limit)}`;
}

/** Compares two manifests' client weights; positive deltas are growth. */
export function diffWeights(
  before: HypManifest['weights'] | undefined,
  after: HypManifest['weights'],
): Array<{ route: string; jsDelta: number; cssDelta: number; js: number; css: number }> {
  const out: Array<{ route: string; jsDelta: number; cssDelta: number; js: number; css: number }> = [];
  const keys = new Set([...Object.keys(before?.client ?? {}), ...Object.keys(after.client)]);
  for (const key of keys) {
    const a = after.client[key] ?? { js: 0, css: 0 };
    const b = before?.client[key] ?? { js: 0, css: 0 };
    out.push({ route: key, js: a.js, css: a.css, jsDelta: a.js - b.js, cssDelta: a.css - b.css });
  }
  return out.sort((x, y) => Math.abs(y.jsDelta) - Math.abs(x.jsDelta));
}

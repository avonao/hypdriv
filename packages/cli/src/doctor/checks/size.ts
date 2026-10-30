import { type BudgetResult, evaluateBudgets, formatBytes } from '@hypdriv/core';
import { WORKER_SIZE_LIMIT } from '../../analyze/weights';
import { type Check, type CheckContext, type CheckResult, fail, info, pass, skip, warn } from '../types';

function workerNumbers(
  ctx: CheckContext,
): { raw: number; gzip: number; topLevelAwaits: number; source: string } | null {
  if (ctx.analyze?.worker) return { ...ctx.analyze.worker, source: '.hypdriv/analyze.json' };
  const w = ctx.manifest?.weights.worker;
  if (w) return { raw: w.raw, gzip: w.gzip, topLevelAwaits: w.topLevelAwaits, source: 'manifest' };
  return null;
}

function budgetOutcome(ctx: CheckContext, results: BudgetResult[], label: string): CheckResult {
  const failOn = ctx.config.resolved.budgets.failOn;
  const over = results.filter((r) => r.status === 'error');
  const near = results.filter((r) => r.status === 'warn');
  const line = (r: BudgetResult) =>
    `${r.id}${r.target ? ` (${r.target})` : ''}: ${formatBytes(r.actual)} / ${formatBytes(r.limit)}`;
  if (over.length) {
    const message = `${over.length} ${label} budget(s) exceeded.`;
    if (failOn === 'error') return fail(message, { details: over.map(line) });
    if (failOn === 'never') return info(message, { details: over.map(line) });
    return warn(message, { details: over.map(line) });
  }
  if (near.length)
    return warn(`${near.length} ${label} budget(s) above 90% of the limit.`, { details: near.map(line) });
  return pass(
    results.length
      ? `${results.length} ${label} budget(s) within limits.`
      : `No ${label} budgets configured.`,
  );
}

export const sizeChecks: Check[] = [
  {
    id: 'size.worker',
    title: 'Worker bundle size',
    category: 'size',
    platforms: ['cloudflare'],
    severity: 'error',
    run(ctx) {
      const w = workerNumbers(ctx);
      if (!w)
        return skip('No worker measurements; run `hypdriv analyze` after `opennextjs-cloudflare build`.');
      const share = w.raw / WORKER_SIZE_LIMIT;
      const summary = `${formatBytes(w.raw)} raw · ${formatBytes(w.gzip)} gzip (${(share * 100).toFixed(0)}% of the 64 MiB limit, from ${w.source})`;
      if (w.raw > WORKER_SIZE_LIMIT)
        return fail(`Worker exceeds Cloudflare's 64 MiB uncompressed limit: ${summary}.`);
      if (share > 0.9) return warn(`Worker is close to the 64 MiB limit: ${summary}.`);
      const budgets = evaluateBudgets(ctx.config.resolved.budgets, {
        routes: [],
        worker: { raw: w.raw, gzip: w.gzip },
      });
      const outcome = budgetOutcome(ctx, budgets, 'worker');
      if (outcome.status !== 'pass') return { ...outcome, message: `${summary}. ${outcome.message}` };
      return pass(summary);
    },
  },
  {
    id: 'size.startup-risk',
    title: 'Worker startup risk',
    category: 'size',
    platforms: ['cloudflare'],
    severity: 'warn',
    run(ctx) {
      const w = workerNumbers(ctx);
      if (!w) return skip('No worker measurements; run `hypdriv analyze`.');
      if (w.topLevelAwaits > 0)
        return warn(
          `${w.topLevelAwaits} top-level await(s) in the bundle's entry region run inside the 1 s global-scope budget; move work into request handlers or lazy imports.`,
        );
      return pass('No top-level await in the bundle entry; OpenNext is imported lazily.');
    },
  },
  {
    id: 'size.client-routes',
    title: 'Client JS/CSS budgets per route',
    category: 'size',
    severity: 'error',
    run(ctx) {
      const m = ctx.manifest;
      if (!m) return skip('no manifest.');
      const results = (m.budgets ?? []).filter((b) => b.scope === 'route');
      return budgetOutcome(ctx, results, 'route');
    },
  },
  {
    id: 'size.total-js',
    title: 'Total client JS budget',
    category: 'size',
    severity: 'warn',
    run(ctx) {
      const m = ctx.manifest;
      if (!m) return skip('no manifest.');
      const results = (m.budgets ?? []).filter((b) => b.scope === 'total');
      if (!results.length) return pass('No total JS budget configured (`budgets.totalJs`).');
      return budgetOutcome(ctx, results, 'total JS');
    },
  },
  {
    id: 'size.largest-route',
    title: 'Heaviest route',
    category: 'size',
    severity: 'info',
    run(ctx) {
      const m = ctx.manifest;
      if (!m) return skip('no manifest.');
      const entries = Object.entries(m.weights.client).sort((a, b) => b[1].js - a[1].js);
      const top = entries[0];
      if (!top) return skip('no client weights in the manifest.');
      const [id, w] = top;
      if (w.js > 300_000)
        return info(
          `${id} ships ${formatBytes(w.js)} of JS (gzip); consider code splitting or a route budget.`,
        );
      return pass(`${id}: ${formatBytes(w.js)} JS · ${formatBytes(w.css)} CSS (gzip).`);
    },
  },
];

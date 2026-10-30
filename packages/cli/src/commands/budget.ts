import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BudgetResult,
  diffWeights,
  evaluateBudgets,
  formatBytes,
  type HypManifest,
} from '@hypdriv/core';
import { readAnalyzeSnapshot, routeWeights } from '../analyze/weights';
import { createContext } from '../context';
import { bytes, delta, type Ui } from '../ui';
import { exists, readJsonFile, writeText } from '../util/fs';
import { defineCommand } from './types';

export interface BudgetSnapshot {
  version: 1;
  buildId: string;
  generatedAt: string;
  weights: HypManifest['weights'];
  budgets: BudgetResult[];
}

/** Evaluates budgets from the manifest plus optional worker numbers. */
export function evaluateProjectBudgets(
  manifest: HypManifest,
  budgets: Parameters<typeof evaluateBudgets>[0],
  worker: { raw: number; gzip: number } | null,
): BudgetResult[] {
  const routes = routeWeights(manifest).map((r) => ({
    id: r.id,
    pathname: r.pathname,
    js: r.js,
    css: r.css,
  }));
  const total = manifest.budgets?.find((b) => b.id === 'total:js');
  return evaluateBudgets(budgets, {
    routes,
    ...(worker ? { worker } : {}),
    ...(total ? { totalJs: total.actual } : {}),
  });
}

/** The most recent snapshot by mtime, excluding the current build. */
export function previousSnapshot(dir: string, currentBuildId: string): BudgetSnapshot | null {
  if (!exists(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== `${currentBuildId}.json`)
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    const snap = readJsonFile<BudgetSnapshot>(f.file);
    if (snap?.version === 1) return snap;
  }
  return null;
}

/** Markdown table for PR comments. */
export function renderBudgetMarkdown(input: {
  buildId: string;
  budgets: BudgetResult[];
  diff: ReturnType<typeof diffWeights> | null;
  worker: { raw: number; gzip: number } | null;
  previousWorker: { raw: number; gzip: number } | null;
  previousBuildId: string | null;
}): string {
  const lines: string[] = [];
  const icon = (s: BudgetResult['status']) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '❌');
  lines.push(`### HypDriv budgets — build \`${input.buildId}\``);
  lines.push('');
  if (input.budgets.length) {
    lines.push('| Budget | Target | Actual | Limit | Status |');
    lines.push('| --- | --- | ---: | ---: | :---: |');
    for (const b of input.budgets) {
      const fmt = b.metric === 'startupMs' ? (n: number) => `${n} ms` : formatBytes;
      lines.push(
        `| \`${b.id}\` | ${b.target ? `\`${b.target}\`` : '—'} | ${fmt(b.actual)} | ${fmt(b.limit)} | ${icon(b.status)} |`,
      );
    }
  } else lines.push('_No budgets configured._');
  if (input.worker) {
    lines.push('');
    const d = input.previousWorker
      ? ` (${delta(input.worker.raw - input.previousWorker.raw)} raw, ${delta(input.worker.gzip - input.previousWorker.gzip)} gzip)`
      : '';
    lines.push(`Worker: ${formatBytes(input.worker.raw)} raw · ${formatBytes(input.worker.gzip)} gzip${d}`);
  }
  if (input.diff) {
    const changed = input.diff.filter((d) => d.jsDelta !== 0 || d.cssDelta !== 0);
    lines.push('');
    lines.push(`#### Route weight changes vs \`${input.previousBuildId ?? 'previous'}\``);
    lines.push('');
    if (!changed.length) lines.push('_No changes._');
    else {
      lines.push('| Route | JS | Δ JS | CSS | Δ CSS |');
      lines.push('| --- | ---: | ---: | ---: | ---: |');
      for (const d of changed.slice(0, 40))
        lines.push(
          `| \`${d.route}\` | ${formatBytes(d.js)} | ${delta(d.jsDelta)} | ${formatBytes(d.css)} | ${delta(d.cssDelta)} |`,
        );
      if (changed.length > 40) lines.push(`| … | | ${changed.length - 40} more | | |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export const budgetCommand = defineCommand({
  name: 'budget',
  summary:
    'Evaluate budgets from the manifest and worker report; store snapshots and diff against the previous build',
  usage: 'hypdriv budget [--ci] [--snapshot] [--diff] [--markdown]',
  options: {
    ci: {
      type: 'boolean',
      description: 'Exit 1 when a budget is exceeded (or warned, with budgets.failOn: warn)',
    },
    snapshot: { type: 'boolean', description: 'Store .hypdriv/snapshots/<buildId>.json' },
    diff: { type: 'boolean', description: 'Compare with the previous snapshot' },
    markdown: { type: 'boolean', description: 'Print a Markdown table (PR comment)' },
  },
  examples: ['hypdriv budget --ci', 'hypdriv budget --snapshot --diff --markdown > budget.md'],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const manifest = ctx.requireManifest();
    const config = await ctx.loadConfig();
    const analyze = readAnalyzeSnapshot(ctx.root);
    const worker = analyze?.worker
      ? { raw: analyze.worker.raw, gzip: analyze.worker.gzip }
      : manifest.weights.worker
        ? { raw: manifest.weights.worker.raw, gzip: manifest.weights.worker.gzip }
        : null;
    const budgets = evaluateProjectBudgets(manifest, config.resolved.budgets, worker);
    const snapshotDir = join(ctx.root, config.resolved.budgets.snapshotDir);
    const weights: HypManifest['weights'] = {
      client: manifest.weights.client,
      ...(worker
        ? { worker: manifest.weights.worker ?? (analyze?.worker ? { ...analyze.worker } : undefined) }
        : {}),
    };
    const previous = args.boolean('diff') ? previousSnapshot(snapshotDir, manifest.buildId) : null;
    const diff = args.boolean('diff') ? diffWeights(previous?.weights, weights) : null;
    let snapshotFile: string | null = null;
    if (args.boolean('snapshot')) {
      snapshotFile = join(snapshotDir, `${manifest.buildId}.json`);
      const snap: BudgetSnapshot = {
        version: 1,
        buildId: manifest.buildId,
        generatedAt: io.date().toISOString(),
        weights,
        budgets,
      };
      writeText(snapshotFile, `${JSON.stringify(snap, null, 2)}\n`);
    }
    const failOn = config.resolved.budgets.failOn;
    const over = budgets.filter((b) => b.status === 'error');
    const near = budgets.filter((b) => b.status === 'warn');
    const failed =
      failOn !== 'never' && (over.length > 0 || (failOn === 'warn' && near.length > 0 && args.boolean('ci')));
    const previousWorker = previous?.weights.worker
      ? { raw: previous.weights.worker.raw, gzip: previous.weights.worker.gzip }
      : null;

    if (args.json) {
      ui.printJson({
        buildId: manifest.buildId,
        failOn,
        budgets,
        worker,
        diff,
        previousBuildId: previous?.buildId ?? null,
        snapshot: snapshotFile,
        ok: !failed,
      });
      return failed && args.boolean('ci') ? 1 : 0;
    }
    if (args.boolean('markdown')) {
      io.stdout.write(
        renderBudgetMarkdown({
          buildId: manifest.buildId,
          budgets,
          diff,
          worker,
          previousWorker,
          previousBuildId: previous?.buildId ?? null,
        }),
      );
      return failed && args.boolean('ci') ? 1 : 0;
    }
    printBudgets(ui, manifest.buildId, budgets, failOn);
    if (worker)
      ui.kv([
        [
          'worker',
          `${bytes(worker.raw)} raw · ${bytes(worker.gzip)} gzip${previousWorker ? ` (${delta(worker.raw - previousWorker.raw)} / ${delta(worker.gzip - previousWorker.gzip)})` : ''}`,
        ],
      ]);
    if (args.boolean('diff')) {
      ui.heading(previous ? `Changes vs ${previous.buildId}` : 'Changes');
      if (!previous) ui.note('No previous snapshot (run with --snapshot on each build to enable diffs).');
      else {
        const changed = (diff ?? []).filter((d) => d.jsDelta !== 0 || d.cssDelta !== 0);
        if (!changed.length) ui.note('No route weight changes.');
        else
          ui.table(
            changed.map((d) => [d.route, bytes(d.js), delta(d.jsDelta), bytes(d.css), delta(d.cssDelta)]),
            {
              columns: [
                'route',
                { header: 'JS', align: 'right' },
                { header: 'Δ JS', align: 'right' },
                { header: 'CSS', align: 'right' },
                { header: 'Δ CSS', align: 'right' },
              ],
            },
          );
      }
    }
    if (snapshotFile)
      ui.note(`\nSnapshot written to ${config.resolved.budgets.snapshotDir}/${manifest.buildId}.json`);
    return failed && args.boolean('ci') ? 1 : 0;
  },
});

function printBudgets(ui: Ui, buildId: string, budgets: BudgetResult[], failOn: string): void {
  ui.heading(`Budgets — build ${buildId} ${ui.color.dim(`(failOn: ${failOn})`)}`);
  if (!budgets.length) {
    ui.note(
      'No budgets configured; add `budgets: { routes: { "/**": { js: "250kb" } }, worker: { gzip: "3mb" } }` to hypdriv.config.ts.',
    );
    return;
  }
  for (const b of budgets) {
    const fmt = b.metric === 'startupMs' ? (n: number) => `${n} ms` : bytes;
    ui.status(
      b.status === 'ok' ? 'pass' : b.status === 'warn' ? 'warn' : 'fail',
      `${b.id}${b.target ? ` (${b.target})` : ''}`,
      `${fmt(b.actual)} / ${fmt(b.limit)}`,
    );
  }
}

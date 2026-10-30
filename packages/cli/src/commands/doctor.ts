import { readAnalyzeSnapshot } from '../analyze/weights';
import { type CommandContext, createContext } from '../context';
import { allChecks } from '../doctor/registry';
import { type DoctorRun, runDoctor } from '../doctor/run';
import { CATEGORY_TITLES, CHECK_CATEGORIES, type CheckContext } from '../doctor/types';
import type { Ui } from '../ui';
import { cliVersion } from '../version';
import { defineCommand } from './types';

/** Builds the shared check context for a command context. */
export async function buildCheckContext(
  ctx: CommandContext,
  options: { fix: boolean },
): Promise<CheckContext> {
  const project = ctx.project();
  const config = await ctx.loadConfig();
  const checkCtx: CheckContext = {
    root: ctx.root,
    project,
    config,
    manifest: project.manifest?.data ?? null,
    analyze: readAnalyzeSnapshot(ctx.root),
    io: ctx.io,
    now: ctx.io.date(),
    cliVersion: cliVersion(),
    fix: options.fix,
  };
  checkCtx.refresh = () => {
    const fresh = createContext(ctx.args, ctx.io);
    checkCtx.project = fresh.project();
    checkCtx.manifest = checkCtx.project.manifest?.data ?? null;
    checkCtx.analyze = readAnalyzeSnapshot(ctx.root);
  };
  return checkCtx;
}

/** Prints the doctor report grouped by category. */
export function printDoctorReport(ui: Ui, run: DoctorRun, options: { compact?: boolean } = {}): void {
  for (const category of CHECK_CATEGORIES) {
    const reports = run.reports.filter((r) => r.category === category);
    if (!reports.length) continue;
    const visible = options.compact
      ? reports.filter((r) => r.status === 'fail' || r.status === 'warn' || r.fixed)
      : reports;
    if (!visible.length) continue;
    ui.heading(CATEGORY_TITLES[category]);
    for (const r of visible) {
      const status = r.status === 'pass' && r.informational ? 'info' : r.status;
      const suffix = r.fixed
        ? ui.color.green(' (fixed)')
        : r.fixable
          ? ui.color.dim(' (fixable with --fix)')
          : '';
      ui.status(status, `${ui.color.bold(r.title)}${suffix}`, r.id);
      ui.line(`    ${r.message}`);
      for (const d of r.details ?? []) ui.line(`      ${ui.color.dim(d)}`);
      if (r.fix && !r.fixed && r.status !== 'pass') ui.line(`      ${ui.color.cyan(`fix: ${r.fix}`)}`);
    }
  }
}

export function printDoctorSummary(ui: Ui, run: DoctorRun, options: { compact?: boolean } = {}): void {
  const s = run.summary;
  const parts = [
    ui.color.green(`${s.pass} passed`),
    s.warn ? ui.color.yellow(`${s.warn} warnings`) : null,
    s.fail ? ui.color.red(`${s.fail} failed`) : null,
    s.skip ? ui.color.gray(`${s.skip} skipped`) : null,
    s.fixed ? ui.color.cyan(`${s.fixed} fixed`) : null,
  ].filter(Boolean);
  if (options.compact) {
    const failed = run.reports.filter((r) => r.status === 'fail');
    const warned = run.reports.filter((r) => r.status === 'warn');
    ui.subheading(`Doctor: ${parts.join(' · ')}`);
    for (const r of failed) ui.status('fail', `${r.title}: ${r.message}`, r.id);
    for (const r of warned.slice(0, 8)) ui.status('warn', `${r.title}: ${r.message}`, r.id);
    if (warned.length > 8) ui.note(`  …and ${warned.length - 8} more warnings (run hypdriv doctor).`);
    return;
  }
  ui.line();
  ui.subheading(`${s.total} checks: ${parts.join(' · ')}`);
}

export const doctorCommand = defineCommand({
  name: 'doctor',
  summary:
    'Run 40+ checks on environment, Next.js, OpenNext, wrangler, Workers compatibility, HypDriv setup, size, security, Purser and dependencies',
  usage: 'hypdriv doctor [--fix] [--ci] [--only <ids>] [--category <name>]',
  options: {
    fix: {
      type: 'boolean',
      description: 'Apply safe fixes (cron sync, observability, _headers, scripts, .dev.vars.example)',
    },
    ci: { type: 'boolean', description: 'Compact output; exit 1 on any failed check' },
    only: { type: 'string', value: '<ids>', description: 'Comma-separated check ids to run', multiple: true },
    category: {
      type: 'string',
      value: '<name>',
      description: 'Only checks of this category',
      multiple: true,
    },
    'list-checks': { type: 'boolean', description: 'Print the check catalogue and exit' },
  },
  examples: [
    'hypdriv doctor',
    'hypdriv doctor --fix',
    'hypdriv doctor --ci --json',
    'hypdriv doctor --only wrangler.crons,wrangler.main',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    if (args.boolean('list-checks')) {
      if (args.json)
        ui.printJson(
          allChecks.map(({ id, title, category, severity }) => ({ id, title, category, severity })),
        );
      else
        ui.table(
          allChecks.map((c) => [c.id, c.category, c.severity, c.title]),
          { columns: ['id', 'category', 'severity', 'title'] },
        );
      return 0;
    }
    const categories = args.list('category');
    const only = args.list('only');
    const selected = allChecks.filter(
      (c) => (!categories.length || categories.includes(c.category)) && (!only.length || only.includes(c.id)),
    );
    if (!selected.length) {
      ui.error('no checks match the given --only/--category filters');
      return 2;
    }
    const checkCtx = await buildCheckContext(ctx, { fix: args.boolean('fix') });
    const run = await runDoctor(selected, checkCtx, { fix: args.boolean('fix') });
    const compact = args.boolean('ci');
    if (!args.json) {
      ui.line(
        `${ui.color.bold('hypdriv doctor')} ${ui.color.dim(`v${cliVersion()} · ${checkCtx.project.root} · platform ${checkCtx.project.platform}${checkCtx.project.platformDetection.explicit ? ' (--platform)' : ''}`)}`,
      );
      printDoctorReport(ui, run, { compact });
      printDoctorSummary(ui, run);
    } else {
      ui.printJson({
        version: cliVersion(),
        root: checkCtx.project.root,
        generatedAt: checkCtx.now.toISOString(),
        summary: run.summary,
        checks: run.reports,
        project: {
          name: checkCtx.project.name,
          platform: checkCtx.project.platform,
          platformSignals: checkCtx.project.platformDetection.signals,
          packageManager: checkCtx.project.packageManager,
          next: checkCtx.project.next.installed,
          react: checkCtx.project.react.installed,
          opennext: checkCtx.project.opennext.installed,
          wrangler: checkCtx.project.wrangler.installed,
          typescript: checkCtx.project.typescript.installed,
          hypdriv: checkCtx.project.hypdriv.installed,
          purser: checkCtx.project.purser.installed,
          configFile: checkCtx.config.file,
          manifest: checkCtx.manifest
            ? { buildId: checkCtx.manifest.buildId, routes: checkCtx.manifest.routes.length }
            : null,
        },
      });
    }
    return run.exitCode;
  },
});

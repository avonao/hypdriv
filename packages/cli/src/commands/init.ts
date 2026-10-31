import { createContext } from '../context';
import { allChecks } from '../doctor/registry';
import { runDoctor } from '../doctor/run';
import { applyInitPlan, buildInitPlan, type PlanItem } from '../init/plan';
import { cliInvocation, FRAMEWORK_LABEL } from '../project';
import { cliVersion } from '../version';
import { buildCheckContext, printDoctorSummary } from './doctor';
import { defineCommand } from './types';

const ACTION_LABEL: Record<PlanItem['action'], string> = {
  create: 'create',
  modify: 'modify',
  skip: 'skip  ',
  manual: 'manual',
};

export const initCommand = defineCommand({
  name: 'init',
  summary:
    'Detect the project and write/update the HypDriv files (config, framework registration, worker entry, wrangler, proxy, headers, scripts)',
  usage: 'hypdriv init [--platform cloudflare|vercel|node] [--purser] [--no-proxy] [--yes] [--dry-run]',
  options: {
    purser: { type: 'boolean', description: 'Scaffold the Purser CSS section of hypdriv.config.ts' },
    'no-proxy': { type: 'boolean', description: 'Do not create proxy.ts' },
    yes: { type: 'boolean', short: 'y', description: 'Accepted for scripts; init never prompts' },
    'dry-run': { type: 'boolean', description: 'Print the plan without writing anything' },
    'skip-doctor': { type: 'boolean', description: 'Do not run the doctor afterwards' },
  },
  examples: [
    'hypdriv init',
    'hypdriv init --purser --dry-run',
    'hypdriv init --platform vercel',
    'hypdriv init --root apps/web --no-proxy',
  ],
  details:
    'Idempotent: files that exist are skipped, edited files are backed up as <name>.hypdriv.bak first.\nCloudflare (default): hypdriv.worker.ts, wrangler.jsonc#main, tsconfig exclude, public/_headers, .dev.vars.example.\nVercel: no Worker files; jobs.cron is written to vercel.json#crons and secrets to .env.example.',
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const project = ctx.project();
    const loaded = project.hypdrivConfigFile ? await ctx.loadConfig() : null;
    const plan = buildInitPlan(project, loaded, {
      purser: args.boolean('purser'),
      noProxy: args.boolean('no-proxy'),
      now: io.date(),
      cliVersion: cliVersion(),
    });
    const dryRun = args.boolean('dry-run');

    ui.heading(`hypdriv init — ${project.name} (${project.root})`);
    const signals = project.platformDetection.signals;
    ui.kv([
      [
        'platform',
        `${plan.platform}${project.platformDetection.explicit ? ' (--platform)' : ` (detected: ${project.platform}${signals.cloudflare.length || signals.vercel.length ? `; ${[...signals.cloudflare, ...signals.vercel].join(', ')}` : ''})`}`,
      ],
      [
        'framework',
        `${FRAMEWORK_LABEL[project.framework.name]}${project.framework.version ? ` ${project.framework.version}` : ''}`,
      ],
      ...(project.framework.name === 'next' || project.framework.name === 'unknown'
        ? ([['@opennextjs/cloudflare', project.opennext.installed ?? 'not installed']] as Array<
            [string, string]
          >)
        : ([
            [
              'integration',
              project.framework.integrationInstalled ?? `${project.framework.integration} (not installed)`,
            ],
          ] as Array<[string, string]>)),
      ['wrangler', project.wrangler.installed ?? 'not installed'],
      ['wrangler config', project.wrangler.configFile ? `${project.wrangler.format}` : 'none'],
      ['package manager', project.packageManager],
      [
        'purser',
        plan.purser
          ? `scaffolded${project.purser.installed ? ` (@avonao/purser ${project.purser.installed})` : ''}`
          : 'not scaffolded (use --purser)',
      ],
    ]);
    ui.line();
    ui.subheading(dryRun ? 'Plan (dry run)' : 'Plan');
    for (const item of plan.items) {
      const icon =
        item.action === 'create'
          ? ui.color.green('+')
          : item.action === 'modify'
            ? ui.color.yellow('~')
            : item.action === 'manual'
              ? ui.color.magenta('!')
              : ui.color.gray('=');
      ui.line(`  ${icon} ${ACTION_LABEL[item.action]}  ${item.path}  ${ui.color.dim(item.reason)}`);
      for (const d of item.details ?? []) ui.line(`              ${ui.color.dim(`- ${d}`)}`);
    }
    for (const item of plan.items) {
      if (item.action !== 'manual' || !item.hint) continue;
      ui.line();
      ui.line(ui.color.magenta(`Manual step for ${item.path}:`));
      for (const l of item.hint.split('\n')) ui.line(`    ${l}`);
    }

    let applied: ReturnType<typeof applyInitPlan> | null = null;
    if (!dryRun) {
      applied = applyInitPlan(plan, project.root);
      ui.line();
      if (applied.written.length)
        ui.status(
          'pass',
          `Wrote ${applied.written.length} file(s)${applied.backups.length ? `, backups: ${applied.backups.join(', ')}` : ''}.`,
        );
      else ui.status('pass', 'Nothing to write; the project is already set up.');
    }
    if (plan.notes.length) {
      ui.line();
      ui.subheading('Notes');
      ui.list(plan.notes);
    }

    let doctor: Awaited<ReturnType<typeof runDoctor>> | null = null;
    if (!dryRun && !args.boolean('skip-doctor')) {
      try {
        const fresh = createContext(args, io);
        const checkCtx = await buildCheckContext(fresh, { fix: false });
        doctor = await runDoctor(allChecks, checkCtx);
        ui.line();
        printDoctorSummary(ui, doctor, { compact: true });
      } catch (err) {
        ui.warn(`doctor could not run: ${(err as Error).message}`);
      }
    }

    ui.line();
    ui.subheading('Next steps');
    plan.nextSteps.forEach((step, i) => ui.line(`  ${i + 1}. ${step}`));
    ui.line();
    ui.note(
      `Run \`${cliInvocation(project.packageManager)} doctor\` any time; \`${cliInvocation(project.packageManager)} agent\` prints a briefing for coding agents.`,
    );

    if (args.json) {
      ui.printJson({
        root: project.root,
        platform: plan.platform,
        dryRun,
        purser: plan.purser,
        plan: plan.items.map(({ content: _content, ...rest }) => rest),
        written: applied?.written ?? [],
        backups: applied?.backups ?? [],
        notes: plan.notes,
        nextSteps: plan.nextSteps,
        doctor: doctor
          ? {
              summary: doctor.summary,
              failed: doctor.reports
                .filter((r) => r.status === 'fail')
                .map((r) => ({ id: r.id, message: r.message })),
            }
          : null,
      });
    }
    return 0;
  },
});

import { type ExperimentSpec, experimentControl, type FlagDefinition } from '@hypdriv/core';
import {
  AnalyticsEngineQueryError,
  buildExperimentReport,
  type ExperimentDescription,
  type ExperimentReport,
  type ExperimentRows,
  experimentExposuresSql,
  experimentVitalsSql,
  formatVital,
  queryAnalyticsEngine,
} from '@hypdriv/observe';
import { CliError, createContext } from '../context';
import { defineCommand } from './types';

export { experimentExposuresSql, experimentVitalsSql };

export interface ExperimentSummary extends ExperimentDescription {
  /** Share of the audience that takes part (0–100). */
  traffic: number;
  audience: boolean;
  salt: string | null;
  expose: string[] | null;
  description: string | null;
}

/** The experiments the configuration defines, in name order. */
export function configuredExperiments(definitions: Record<string, FlagDefinition>): ExperimentSummary[] {
  return Object.entries(definitions)
    .filter(
      (entry): entry is [string, FlagDefinition & { experiment: ExperimentSpec }] => !!entry[1].experiment,
    )
    .map(([name, def]) => ({
      name,
      control: experimentControl(def, def.experiment),
      weights: def.experiment.variants,
      status: def.experiment.status ?? 'running',
      ...(def.experiment.winner ? { winner: def.experiment.winner } : {}),
      traffic: def.experiment.traffic ?? 100,
      audience: !!def.experiment.when,
      salt: def.experiment.salt ?? null,
      expose: def.experiment.expose ?? null,
      description: def.description ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`;

export const experimentsCommand = defineCommand({
  name: 'experiments',
  summary: 'Edge A/B experiments: what is configured, and visitors + Web Vitals per variant (--results)',
  usage: 'hypdriv experiments [--results] [--name <experiment>] [--days 14] [--dataset <name>] [--sql]',
  options: {
    results: {
      type: 'boolean',
      description:
        'Query Workers Analytics Engine (CF_ACCOUNT_ID, CF_API_TOKEN) for visitors and p75 vitals per variant',
    },
    name: { type: 'string', value: '<experiment>', description: 'Only this experiment' },
    days: {
      type: 'string',
      value: '<n>',
      description: 'Look-back window in days for --results',
      default: '14',
    },
    dataset: {
      type: 'string',
      value: '<name>',
      description: 'Dataset (default: from wrangler analytics_engine_datasets for the exposures binding)',
    },
    sql: { type: 'boolean', description: 'Print the SQL of --results and exit' },
  },
  examples: [
    'hypdriv experiments',
    'hypdriv experiments --json',
    'CF_ACCOUNT_ID=… CF_API_TOKEN=… hypdriv experiments --results --days 14',
    'hypdriv experiments --results --name checkout --sql',
  ],
  details:
    'Experiments are flags with an `experiment` block in `flags.definitions`. The report shows the visitors each variant received against the configured weights (a sample ratio mismatch means the comparison cannot be trusted), and p75 LCP/INP/CLS per variant, from the exposures the flags stage and the vitals beacon write to Analytics Engine. Needs a token with Account Analytics: Read.',
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const config = await ctx.loadConfig();
    const only = args.string('name') ?? null;
    let experiments = configuredExperiments(config.resolved.flags.definitions);
    if (only) {
      experiments = experiments.filter((e) => e.name === only);
      if (!experiments.length) throw new CliError(`No experiment named "${only}" in flags.definitions.`);
    }
    const results = args.boolean('results') || args.boolean('sql');
    if (!results) return printConfigured(ctx, experiments, config.resolved.flags.exposures);

    if (!experiments.length) {
      throw new CliError('No experiments defined. Add an `experiment` block to a flag in flags.definitions.');
    }
    const project = ctx.project({ scan: false });
    const binding = config.resolved.flags.exposuresBinding;
    const declared = project.wrangler.config?.analytics_engine_datasets.find((d) => d.binding === binding);
    const dataset =
      args.string('dataset') ??
      (declared ? (typeof declared.dataset === 'string' ? declared.dataset : binding) : null);
    const days = args.number('days', 14, { min: 1, max: 90 });
    if (!dataset) {
      throw new CliError(
        project.platform === 'vercel'
          ? 'Analytics Engine is a Cloudflare feature; on Vercel experiment exposures go to the log (flags.exposures: "log"): query your log drain for `experiment exposure` lines.'
          : `No Analytics Engine dataset bound as ${binding} in the wrangler config. Add \`"analytics_engine_datasets": [{ "binding": "${binding}", "dataset": "<name>" }]\`, set flags.exposuresBinding, or pass --dataset.`,
      );
    }
    const exposuresSql = experimentExposuresSql(dataset, { days, ...(only ? { experiment: only } : {}) });
    const vitalsSqlOf = (e: ExperimentSummary, variant: string) =>
      experimentVitalsSql(dataset, { days, experiment: e.name, variant });
    if (args.boolean('sql')) {
      const queries = [
        { query: 'exposures', sql: exposuresSql },
        ...experiments.flatMap((e) =>
          Object.keys(e.weights).map((variant) => ({
            query: `vitals ${e.name}:${variant}`,
            sql: vitalsSqlOf(e, variant),
          })),
        ),
      ];
      if (args.json) ui.printJson({ dataset, queries });
      else for (const q of queries) io.stdout.write(`-- ${q.query}\n${q.sql}\n\n`);
      return 0;
    }
    const accountId = io.env.CF_ACCOUNT_ID ?? io.env.CLOUDFLARE_ACCOUNT_ID;
    const token = io.env.CF_API_TOKEN ?? io.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) {
      throw new CliError(
        `Set ${!accountId ? 'CF_ACCOUNT_ID' : ''}${!accountId && !token ? ' and ' : ''}${!token ? 'CF_API_TOKEN (Account Analytics: Read)' : ''} to query Analytics Engine (dataset ${dataset}).`,
      );
    }
    const query = async (sql: string) => {
      try {
        return await queryAnalyticsEngine({
          accountId,
          apiToken: token,
          sql,
          fetch: io.fetch,
          timeoutMs: 30_000,
        });
      } catch (err) {
        if (err instanceof AnalyticsEngineQueryError) throw new CliError(err.message);
        throw err;
      }
    };
    const exposures = await query(exposuresSql);
    const reports: ExperimentReport[] = [];
    for (const e of experiments) {
      const seen = new Set(
        exposures.filter((r) => String(r.experiment ?? '') === e.name).map((r) => String(r.variant)),
      );
      const variants = [...new Set([...Object.keys(e.weights), ...seen])].filter((v) =>
        /^[A-Za-z0-9_-]{1,48}$/.test(v),
      );
      const vitals: ExperimentRows['vitals'] = {};
      // Variants with no exposures have no vitals either; skipping them saves a query each.
      for (const variant of variants)
        if (seen.has(variant)) vitals[variant] = await query(vitalsSqlOf(e, variant));
      reports.push(buildExperimentReport(e, { exposures, vitals }, { days }));
    }
    if (args.json) {
      ui.printJson({ dataset, days, experiments: reports });
      return 0;
    }
    for (const report of reports) printReport(ctx, report, dataset);
    return reports.some((r) => r.sampleRatio.status === 'mismatch') ? 1 : 0;
  },
});

type Ctx = ReturnType<typeof createContext>;

function printConfigured(ctx: Ctx, experiments: ExperimentSummary[], exposures: string): number {
  const { ui, args } = ctx;
  if (args.json) {
    ui.printJson({ exposures, experiments });
    return 0;
  }
  ui.heading('Experiments');
  if (!experiments.length) {
    ui.note(
      'None defined. Give a flag an `experiment` block in flags.definitions: { default: "control", experiment: { variants: { control: 50, b: 50 } } }.',
    );
    return 0;
  }
  ui.table(
    experiments.map((e) => {
      const total = Object.values(e.weights).reduce((a, b) => a + Math.max(b, 0), 0) || 1;
      const status =
        e.status === 'running'
          ? ui.color.green(e.status)
          : e.status === 'paused'
            ? ui.color.yellow(e.status)
            : `${e.status}${e.winner ? ` → ${e.winner}` : ''}`;
      return [
        e.name,
        status,
        Object.entries(e.weights)
          .map(([v, w]) => `${v}${v === e.control ? '*' : ''} ${Math.round((Math.max(w, 0) / total) * 100)}%`)
          .join(' · '),
        e.traffic === 100 ? '100%' : `${e.traffic}%`,
        e.audience ? 'rules' : 'everyone',
      ];
    }),
    { columns: ['experiment', 'status', 'variants (* control)', 'traffic', 'audience'] },
  );
  ui.note(`Exposures: ${exposures}. Results: hypdriv experiments --results (needs Analytics Engine).`);
  return 0;
}

function printReport(ctx: Ctx, report: ExperimentReport, dataset: string): void {
  const { ui } = ctx;
  ui.heading(
    `${report.name} — ${report.status}${report.winner ? ` → ${report.winner}` : ''} · last ${report.days} day(s) · dataset ${dataset}`,
  );
  if (!report.visitors) {
    ui.note('No exposures yet (is the flags stage running, and are exposures going to Analytics Engine?).');
    return;
  }
  const metrics = ['LCP', 'INP', 'CLS'] as const;
  ui.table(
    report.variants.map((v) => [
      `${v.variant}${v.isControl ? ' (control)' : ''}${v.defined ? '' : ' (removed)'}`,
      String(v.visitors),
      v.defined ? `${pct(v.share)} / ${pct(v.expectedShare)}` : pct(v.share),
      ...metrics.map((m) => {
        const r = v.metrics[m];
        if (!r) return '—';
        const text = formatVital(m, r.p75);
        const colored =
          r.rating === 'good'
            ? ui.color.green(text)
            : r.rating === 'poor'
              ? ui.color.red(text)
              : ui.color.yellow(text);
        return r.deltaVsControl === undefined ? colored : `${colored} ${signed(r.deltaVsControl)}`;
      }),
    ]),
    {
      columns: [
        'variant',
        { header: 'visitors', align: 'right' },
        { header: 'share / expected', align: 'right' },
        ...metrics.map((m) => ({ header: `${m} p75`, align: 'right' as const })),
      ],
    },
  );
  const sr = report.sampleRatio;
  if (sr.status === 'mismatch') {
    ui.warn(
      `Sample ratio mismatch (χ² ${sr.chiSquare?.toFixed(1)}, p ${sr.p !== null && sr.p < 0.0001 ? '< 0.0001' : sr.p?.toFixed(4)}): the split differs from the weights by more than chance explains. A redirect, a cache that ignores vary.flags or bots can cause this — fix it before reading the vitals.`,
    );
  } else if (sr.status === 'insufficient') {
    ui.note('Too few visitors for a sample ratio check (needs 100 across two or more variants).');
  } else {
    ui.note(`Sample ratio ok (χ² ${sr.chiSquare?.toFixed(2)}, p ${sr.p?.toFixed(3)}).`);
  }
}

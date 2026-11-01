import {
  AnalyticsEngineQueryError,
  parseBucketTime,
  queryAnalyticsEngine,
  rateVital as rateKnownVital,
  trendBucketSeconds,
  VITAL_NAMES,
  type VitalName,
  vitalsSql,
  vitalsTrendSql,
} from '@hypdriv/observe';
import { CliError, createContext } from '../context';
import { defineCommand } from './types';

export { VITAL_NAMES, vitalsSql };

/** Rates a metric by name; `unknown` for anything the vitals sinks do not record. */
export function rateVital(metric: string, value: number): 'good' | 'needs-improvement' | 'poor' | 'unknown' {
  return (VITAL_NAMES as readonly string[]).includes(metric)
    ? rateKnownVital(metric as VitalName, value)
    : 'unknown';
}

/** Milliseconds for timings, three decimals for CLS (the table stays comparable across rows). */
function formatMetric(metric: string, v: number): string {
  return metric === 'CLS' ? v.toFixed(3) : `${Math.round(v)} ms`;
}

export interface VitalsRow {
  route: string;
  metric: string;
  p75: number;
  p50: number;
  samples: number;
  rating: ReturnType<typeof rateVital>;
}

export const vitalsCommand = defineCommand({
  name: 'vitals',
  summary: 'p75 Web Vitals per route and metric from Workers Analytics Engine (CF_ACCOUNT_ID, CF_API_TOKEN)',
  usage: 'hypdriv vitals [--days 7] [--route <path>] [--dataset <name>] [--trend]',
  options: {
    days: { type: 'string', value: '<n>', description: 'Look-back window in days', default: '7' },
    route: { type: 'string', value: '<path>', description: 'Only this route (route id/pattern or pathname)' },
    dataset: {
      type: 'string',
      value: '<name>',
      description: 'Dataset (default: from wrangler analytics_engine_datasets for HYPDRIV_ANALYTICS)',
    },
    trend: {
      type: 'boolean',
      description: 'p75 over time (hourly, 6-hourly or daily buckets) instead of per route',
    },
    sql: { type: 'boolean', description: 'Print the SQL and exit' },
  },
  examples: [
    'CF_ACCOUNT_ID=… CF_API_TOKEN=… hypdriv vitals --days 7',
    'hypdriv vitals --route /blog/[slug] --json',
    'hypdriv vitals --trend --days 14',
  ],
  details:
    'Needs a token with Account Analytics: Read. On Vercel, use Speed Insights (vitals are logged by the default sink). The same numbers are on the token-protected /_hypdriv/dash page when observe.vitals.dashboard is on.',
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const config = await ctx.loadConfig();
    const project = ctx.project({ scan: false });
    const binding =
      config.resolved.observe.vitals?.analyticsEngineBinding ??
      config.resolved.cloudflare.bindings.analyticsEngine;
    const declared = project.wrangler.config?.analytics_engine_datasets.find((d) => d.binding === binding);
    const dataset =
      args.string('dataset') ??
      (declared ? (typeof declared.dataset === 'string' ? declared.dataset : binding) : null);
    const days = args.number('days', 7, { min: 1, max: 90 });
    const route = args.string('route') ?? null;
    if (!dataset) {
      const why =
        project.platform === 'vercel'
          ? 'Analytics Engine is a Cloudflare feature; on Vercel use Speed Insights (or keep observe.vitals.sink: "log" and query your log drain).'
          : `No Analytics Engine dataset bound as ${binding} in the wrangler config. Add \`"analytics_engine_datasets": [{ "binding": "${binding}", "dataset": "<name>" }]\`, set observe.vitals.sink: 'analytics-engine', or pass --dataset.`;
      throw new CliError(why);
    }
    const trend = args.boolean('trend');
    const bucketSeconds = trendBucketSeconds(days);
    const sql = trend
      ? vitalsTrendSql(dataset, { days, route, bucketSeconds })
      : vitalsSql(dataset, { days, route });
    if (args.boolean('sql')) {
      if (args.json) ui.printJson({ dataset, sql });
      else io.stdout.write(`${sql}\n`);
      return 0;
    }
    const accountId = io.env.CF_ACCOUNT_ID ?? io.env.CLOUDFLARE_ACCOUNT_ID;
    const token = io.env.CF_API_TOKEN ?? io.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) {
      throw new CliError(
        `Set ${!accountId ? 'CF_ACCOUNT_ID' : ''}${!accountId && !token ? ' and ' : ''}${!token ? 'CF_API_TOKEN (Account Analytics: Read)' : ''} to query Analytics Engine (dataset ${dataset}).`,
      );
    }
    let data: Array<Record<string, unknown>>;
    try {
      data = await queryAnalyticsEngine({
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
    if (trend) return printTrend(ctx, data, { dataset, days, route });
    const rows: VitalsRow[] = data.map((d) => {
      const metric = String(d.metric ?? '');
      const p75 = Number(d.p75 ?? 0);
      return {
        route: String(d.route ?? ''),
        metric,
        p75,
        p50: Number(d.p50 ?? 0),
        samples: Math.round(Number(d.samples ?? 0)),
        rating: rateVital(metric, p75),
      };
    });
    if (args.json) {
      ui.printJson({ dataset, days, route, rows });
      return 0;
    }
    ui.heading(`Web Vitals p75 — last ${days} day(s) · dataset ${dataset}${route ? ` · ${route}` : ''}`);
    if (!rows.length) {
      ui.note(
        'No data points (is the vitals sink set to analytics-engine and <VitalsReporter /> rendered?).',
      );
      return 0;
    }
    const fmt = formatMetric;
    const routes = [...new Set(rows.map((r) => r.route))];
    const metrics: readonly string[] = VITAL_NAMES;
    const cell = (r: VitalsRow | undefined) => {
      if (!r) return '—';
      const text = fmt(r.metric, r.p75);
      return r.rating === 'good'
        ? ui.color.green(text)
        : r.rating === 'poor'
          ? ui.color.red(text)
          : r.rating === 'needs-improvement'
            ? ui.color.yellow(text)
            : text;
    };
    ui.table(
      routes.map((rt) => {
        const own = rows.filter((r) => r.route === rt);
        return [
          rt,
          ...metrics.map((m) => cell(own.find((r) => r.metric === m))),
          String(Math.max(...own.map((r) => r.samples))),
        ];
      }),
      {
        columns: [
          'route',
          ...metrics.map((m) => ({ header: m, align: 'right' as const })),
          { header: 'samples', align: 'right' },
        ],
      },
    );
    return 0;
  },
});

function printTrend(
  ctx: ReturnType<typeof createContext>,
  data: Array<Record<string, unknown>>,
  where: { dataset: string; days: number; route: string | null },
): number {
  const { ui } = ctx;
  const buckets = new Map<number, Partial<Record<VitalName, number>> & { samples?: number }>();
  for (const d of data) {
    const t = parseBucketTime(d.bucket);
    const metric = String(d.metric ?? '') as VitalName;
    const p75 = Number(d.p75);
    if (!Number.isFinite(t) || !Number.isFinite(p75) || !VITAL_NAMES.includes(metric)) continue;
    const entry = buckets.get(t) ?? {};
    entry[metric] = p75;
    entry.samples = Math.max(entry.samples ?? 0, Math.round(Number(d.samples ?? 0)));
    buckets.set(t, entry);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  if (ctx.args.json) {
    ui.printJson({
      ...where,
      trend: points.map(([t, v]) => ({ bucket: new Date(t).toISOString(), ...v })),
    });
    return 0;
  }
  ui.heading(
    `Web Vitals p75 over time — last ${where.days} day(s) · dataset ${where.dataset}${where.route ? ` · ${where.route}` : ''}`,
  );
  if (!points.length) {
    ui.note('No data points (is the vitals sink set to analytics-engine and <VitalsReporter /> rendered?).');
    return 0;
  }
  ui.table(
    points.map(([t, v]) => [
      new Date(t).toISOString().slice(0, 16).replace('T', ' '),
      ...VITAL_NAMES.map((m) => {
        const value = v[m];
        if (value === undefined) return '—';
        const text = formatMetric(m, value);
        const rating = rateKnownVital(m, value);
        return rating === 'good'
          ? ui.color.green(text)
          : rating === 'poor'
            ? ui.color.red(text)
            : ui.color.yellow(text);
      }),
      String(v.samples ?? 0),
    ]),
    {
      columns: [
        'bucket (UTC)',
        ...VITAL_NAMES.map((m) => ({ header: m, align: 'right' as const })),
        { header: 'samples', align: 'right' },
      ],
    },
  );
  return 0;
}

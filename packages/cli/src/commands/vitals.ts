import { CliError, createContext } from '../context';
import { defineCommand } from './types';

/** Web Vitals thresholds (good / poor) from web.dev. */
export const VITAL_THRESHOLDS: Record<string, { good: number; poor: number; unit: 'ms' | '' }> = {
  LCP: { good: 2500, poor: 4000, unit: 'ms' },
  INP: { good: 200, poor: 500, unit: 'ms' },
  CLS: { good: 0.1, poor: 0.25, unit: '' },
  FCP: { good: 1800, poor: 3000, unit: 'ms' },
  TTFB: { good: 800, poor: 1800, unit: 'ms' },
};

export function rateVital(metric: string, value: number): 'good' | 'needs-improvement' | 'poor' | 'unknown' {
  const t = VITAL_THRESHOLDS[metric];
  if (!t) return 'unknown';
  return value <= t.good ? 'good' : value <= t.poor ? 'needs-improvement' : 'poor';
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Analytics Engine SQL for p75 per route and metric over the vitals layout written by
 * `analyticsEngineVitalsSink` (index1 = route, blob1 = metric, blob2 = rating, blob3 = pathname,
 * double1 = value). Sampling is honoured through `_sample_interval` weights.
 */
export function vitalsSql(
  dataset: string,
  options: { days: number; route?: string | null; limit?: number },
): string {
  if (!/^[A-Za-z0-9_]+$/.test(dataset))
    throw new CliError(`invalid Analytics Engine dataset name "${dataset}"`);
  const where = [`timestamp > NOW() - INTERVAL '${Math.max(1, Math.floor(options.days))}' DAY`];
  if (options.route)
    where.push(`(index1 = ${sqlString(options.route)} OR blob3 = ${sqlString(options.route)})`);
  return [
    'SELECT index1 AS route, blob1 AS metric,',
    '  quantileWeighted(0.75, double1, _sample_interval) AS p75,',
    '  quantileWeighted(0.5, double1, _sample_interval) AS p50,',
    '  SUM(_sample_interval) AS samples',
    `FROM ${dataset}`,
    `WHERE ${where.join(' AND ')}`,
    'GROUP BY route, metric',
    'ORDER BY samples DESC',
    `LIMIT ${options.limit ?? 500}`,
    'FORMAT JSON',
  ].join('\n');
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
  usage: 'hypdriv vitals [--days 7] [--route <path>] [--dataset <name>]',
  options: {
    days: { type: 'string', value: '<n>', description: 'Look-back window in days', default: '7' },
    route: { type: 'string', value: '<path>', description: 'Only this route (route id/pattern or pathname)' },
    dataset: {
      type: 'string',
      value: '<name>',
      description: 'Dataset (default: from wrangler analytics_engine_datasets for HYPDRIV_ANALYTICS)',
    },
    sql: { type: 'boolean', description: 'Print the SQL and exit' },
  },
  examples: [
    'CF_ACCOUNT_ID=… CF_API_TOKEN=… hypdriv vitals --days 7',
    'hypdriv vitals --route /blog/[slug] --json',
  ],
  details:
    'Needs a token with Account Analytics: Read. On Vercel, use Speed Insights (vitals are logged by the default sink).',
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
    const sql = vitalsSql(dataset, { days, route });
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
    let res: Response;
    try {
      res = await io.fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
          body: sql,
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (err) {
      throw new CliError(`Analytics Engine request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new CliError(`Analytics Engine returned ${res.status}: ${text.slice(0, 500)}`);
    let data: Array<Record<string, unknown>>;
    try {
      data = ((JSON.parse(text) as { data?: Array<Record<string, unknown>> }).data ?? []) as Array<
        Record<string, unknown>
      >;
    } catch {
      throw new CliError(`unexpected Analytics Engine response: ${text.slice(0, 200)}`);
    }
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
    const fmt = (metric: string, v: number) =>
      VITAL_THRESHOLDS[metric]?.unit === '' ? v.toFixed(3) : `${Math.round(v)} ms`;
    const routes = [...new Set(rows.map((r) => r.route))];
    const metrics = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];
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

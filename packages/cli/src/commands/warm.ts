import { createCacheableTest } from '@hypdriv/cache';
import type { HypManifest } from '@hypdriv/core';
import {
  AnalyticsEngineQueryError,
  type HotPath,
  hotPaths,
  hotPathsSql,
  queryAnalyticsEngine,
} from '@hypdriv/observe';
import { rawList, UsageError } from '../args';
import { cacheStatus } from '../audit/cache';
import { fetchPage, joinUrl, mapConcurrent, normalizeBaseUrl } from '../audit/http';
import { concretePaths, isPageRoute } from '../audit/paths';
import { auditAuth, describeAuditAuth } from '../audit/token';
import { CliError, createContext } from '../context';
import { millis } from '../ui';
import { defineCommand } from './types';

/** Paths to warm: configured `cache.warm.routes`, else every static/ISR page (concrete paths). */
export function warmPaths(manifest: HypManifest | null, configured: string[], explicit: string[]): string[] {
  if (explicit.length) return [...new Set(explicit)];
  if (configured.length) return [...new Set(configured)];
  if (!manifest) return ['/'];
  const out = new Set<string>();
  for (const route of manifest.routes) {
    if (!isPageRoute(route) || route.pathname.startsWith('/_')) continue;
    if (route.classification !== 'static' && route.classification !== 'isr') continue;
    for (const p of concretePaths(route, manifest.basePath)) out.add(p);
  }
  return out.size ? [...out] : ['/'];
}

export const warmCommand = defineCommand({
  name: 'warm',
  summary:
    'Fetch the configured warm routes (or all static/ISR routes) to fill the edge cache after a deploy; --hot adds the busiest pages from Analytics Engine',
  usage: 'hypdriv warm --url <base> [--concurrency 4] [--paths a,b] [--hot [--days 7] [--limit 25]]',
  options: {
    url: { type: 'string', value: '<base>', description: 'Base URL of the deployment' },
    paths: {
      type: 'string',
      value: '<a,b>',
      description: 'Explicit paths (default: cache.warm.routes, else static/ISR routes)',
      multiple: true,
    },
    concurrency: {
      type: 'string',
      value: '<n>',
      description: 'Parallel requests (default: cache.warm.concurrency)',
    },
    hot: {
      type: 'boolean',
      description:
        'Also warm the busiest cacheable pages, learned from Web Vitals in Analytics Engine (CF_ACCOUNT_ID, CF_API_TOKEN)',
    },
    days: {
      type: 'string',
      value: '<n>',
      description: 'With --hot: look-back window in days (default: cache.warm.hot.days, 7)',
    },
    limit: {
      type: 'string',
      value: '<n>',
      description: 'With --hot: pages to add (default: cache.warm.hot.limit, 25)',
    },
    'min-views': {
      type: 'string',
      value: '<n>',
      description:
        'With --hot: ignore pages with fewer measured views (default: cache.warm.hot.minViews, 20)',
    },
    dataset: {
      type: 'string',
      value: '<name>',
      description:
        'With --hot: Analytics Engine dataset (default: the vitals binding in the wrangler config)',
    },
    sql: { type: 'boolean', description: 'With --hot: print the Analytics Engine SQL and exit' },
    timeout: { type: 'string', value: '<ms>', description: 'Per-request timeout', default: '10000' },
    anonymous: {
      type: 'boolean',
      description: 'Send unsigned requests (no x-hypdriv-audit token), as an anonymous visitor would',
    },
    header: {
      type: 'string',
      value: '<name: value>',
      description:
        'Extra request header for a gateway in front of the deployment (repeatable; also HYPDRIV_ACCESS_HEADERS, CF_ACCESS_CLIENT_ID/SECRET, VERCEL_AUTOMATION_BYPASS_SECRET)',
      multiple: true,
    },
  },
  examples: [
    'hypdriv warm --url https://www.example.com',
    'hypdriv warm --url http://localhost:8787 --paths /,/pricing --json',
    'CF_ACCOUNT_ID=… CF_API_TOKEN=… hypdriv warm --url https://www.example.com --hot --limit 50',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required');
    const config = await ctx.loadConfig();
    const manifest = ctx.manifest();
    const wantHot = args.boolean('hot');
    const hotConfig = config.resolved.cache.warm.hot;
    let hot: HotPath[] = [];
    if (wantHot) {
      const project = ctx.project({ scan: false });
      const binding =
        config.resolved.observe.vitals?.analyticsEngineBinding ??
        config.resolved.cloudflare.bindings.analyticsEngine;
      const declared = project.wrangler.config?.analytics_engine_datasets.find((d) => d.binding === binding);
      const dataset =
        args.string('dataset') ??
        hotConfig?.dataset ??
        io.env[hotConfig?.datasetEnv ?? 'HYPDRIV_ANALYTICS_DATASET'] ??
        config.resolved.observe.vitals?.dashboard?.dataset ??
        (declared ? (typeof declared.dataset === 'string' ? declared.dataset : binding) : null);
      if (!dataset) {
        throw new CliError(
          project.platform === 'vercel'
            ? '--hot reads Web Vitals from Analytics Engine, a Cloudflare feature; Vercel has no equivalent here.'
            : `No Analytics Engine dataset bound as ${binding} in the wrangler config. Add \`"analytics_engine_datasets": [{ "binding": "${binding}", "dataset": "<name>" }]\`, set observe.vitals.sink: 'analytics-engine', or pass --dataset.`,
        );
      }
      const days = args.number('days', hotConfig?.days ?? 7, { min: 1, max: 90 });
      const limit = args.number('limit', hotConfig?.limit ?? 25, { min: 1, max: 200 });
      const minViews = args.number('min-views', hotConfig?.minViews ?? 20, { min: 1 });
      const sql = hotPathsSql(dataset, { days, limit });
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
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await queryAnalyticsEngine({
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
      const cacheable = manifest ? createCacheableTest(config.resolved, manifest) : undefined;
      hot = hotPaths(rows, { limit, minViews, ...(cacheable ? { accept: cacheable } : {}) });
    }
    const explicit = args.list('paths');
    const configured = config.resolved.cache.warm.routes;
    const paths = wantHot
      ? [...new Set([...(explicit.length ? explicit : configured), ...hot.map((h) => h.path)])]
      : warmPaths(manifest, configured, explicit);
    if (wantHot && !paths.length) {
      if (args.json) ui.printJson({ url: base, hot, results: [], failed: 0 });
      else
        ui.note('No hot pages yet (is the vitals sink analytics-engine and <VitalsReporter /> rendered?).');
      return 0;
    }
    const concurrency = args.number('concurrency', config.resolved.cache.warm.concurrency, {
      min: 1,
      max: 64,
    });
    const timeoutMs = args.number('timeout', 10_000, { min: 100 });
    const auth = await auditAuth({
      root: ctx.root,
      io,
      base,
      secretName: config.resolved.security.internalAuth.secretEnv,
      anonymous: args.boolean('anonymous'),
      headers: rawList(args, 'header'),
    });
    if (!args.json) {
      ui.heading(
        `Warming ${paths.length} path(s) on ${base} (concurrency ${concurrency})${wantHot ? `, ${hot.length} from the busiest pages` : ''}`,
      );
      ui.note(describeAuditAuth(auth));
    }
    const results = await mapConcurrent(paths, concurrency, async (path) => {
      const page = await fetchPage(
        joinUrl(base, path),
        { fetch: io.fetch, timeoutMs, follow: false, headers: auth.headers },
        io.now,
      );
      const row = {
        path,
        status: page.status,
        cache: cacheStatus(page.headers),
        ms: Math.round(page.totalMs),
        bytes: Buffer.byteLength(page.body),
        error: page.error,
      };
      if (!args.json) {
        const level = page.error || page.status >= 500 ? 'fail' : page.status >= 400 ? 'warn' : 'pass';
        ui.status(
          level,
          `${path}`,
          page.error ?? `${page.status} · ${row.cache ?? 'no cache header'} · ${millis(page.totalMs)}`,
        );
      }
      return row;
    });
    const failed = results.filter((r) => r.error || r.status >= 500);
    if (args.json) ui.printJson({ url: base, ...(wantHot ? { hot } : {}), results, failed: failed.length });
    else {
      ui.line();
      ui.status(
        failed.length ? 'fail' : 'pass',
        `${results.length - failed.length}/${results.length} warmed${failed.length ? `, ${failed.length} failed` : ''}.`,
      );
    }
    return failed.length ? 1 : 0;
  },
});

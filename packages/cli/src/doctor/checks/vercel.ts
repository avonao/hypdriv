import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeVercelOutput } from '../../analyze/vercel';
import { BACKUP_SUFFIX } from '../../init/plan';
import { exists, mtimeMs, readText, rel } from '../../util/fs';
import { isUsRegion, upsertVercelCrons, VERCEL_DEFAULT_REGION, type VercelCron } from '../../vercel-config';
import { type Check, type CheckContext, fail, info, pass, skip, warn } from '../types';

/** Crons that `jobs.cron` implies on Vercel (Vercel Cron calls the job path with GET). */
export function expectedVercelCrons(ctx: Pick<CheckContext, 'config'>): VercelCron[] {
  return Object.values(ctx.config.resolved.jobs.cron).map((j) => ({ path: j.path, schedule: j.cron }));
}

/** Where a variable is available: process env, a `.env*` file or `.dev.vars`. */
export function variableSource(ctx: CheckContext, name: string): string | null {
  if (ctx.io.env[name]) return 'environment';
  const file = ctx.project.envFiles.find((f) => f.keys.includes(name));
  if (file) return file.file;
  if (ctx.project.devVars.keys.includes(name)) return '.dev.vars';
  return null;
}

const ROUTE_FILES = ['route.ts', 'route.js', 'route.mts', 'route.mjs'];

/** Finds the App Router route handler file for a request path (`/api/jobs/digest`). */
export function routeHandlerFile(root: string, path: string): string | null {
  const segments = path.split('?')[0]!.split('/').filter(Boolean);
  for (const base of ['app', 'src/app']) {
    for (const file of ROUTE_FILES) {
      const candidate = join(root, base, ...segments, file);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** `true` when a route module exports a GET handler. */
export function exportsGet(source: string): boolean {
  return (
    /export\s+(?:async\s+)?function\s+GET\b/.test(source) ||
    /export\s+const\s+GET\b/.test(source) ||
    /export\s*\{[^}]*\bGET\b[^}]*\}/.test(source)
  );
}

function vercelJsonFix(ctx: CheckContext, crons: VercelCron[]) {
  const info = ctx.project.vercel;
  if (info.format === 'ts')
    return {
      description: `add ${crons.map((c) => `{ path: '${c.path}', schedule: '${c.schedule}' }`).join(', ')} to crons in vercel.ts`,
    };
  const file = info.configFile ?? join(ctx.root, 'vercel.json');
  return {
    description: `${info.configFile ? 'update' : 'create'} vercel.json crons`,
    apply: () => {
      const existing = readText(file);
      const edit = upsertVercelCrons(existing, crons);
      if (!edit.changes.length) return;
      if (existing !== null) copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
      writeFileSync(file, edit.content);
    },
  };
}

export const vercelChecks: Check[] = [
  {
    id: 'vercel.config',
    title: 'vercel.json / vercel.ts',
    category: 'vercel',
    severity: 'warn',
    run(ctx) {
      const v = ctx.project.vercel;
      const crons = expectedVercelCrons(ctx);
      if (v.parseError) return fail(`${rel(ctx.root, v.configFile!)} could not be parsed: ${v.parseError}`);
      if (v.configFile)
        return pass(`${rel(ctx.root, v.configFile)}${v.format === 'ts' ? ' (read statically)' : ''}`);
      if (crons.length)
        return warn('No vercel.json or vercel.ts; jobs.cron needs `crons` there to run on Vercel Cron.', {
          fix: vercelJsonFix(ctx, crons),
        });
      return pass('No vercel.json (optional: Vercel detects Next.js and deploys with defaults).');
    },
  },
  {
    id: 'vercel.crons',
    title: 'Vercel crons match jobs.cron',
    category: 'vercel',
    severity: 'error',
    run(ctx) {
      const expected = expectedVercelCrons(ctx);
      const declared = ctx.project.vercel.config?.crons ?? [];
      if (!expected.length) {
        if (declared.some((c) => c.path.startsWith(ctx.config.resolved.jobs.basePath)))
          return info(
            `vercel crons call ${declared.map((c) => c.path).join(', ')} but jobs.cron is empty in hypdriv.config.`,
          );
        return pass('No cron jobs configured.');
      }
      const missing = expected.filter(
        (e) => !declared.some((d) => d.path === e.path && d.schedule === e.schedule),
      );
      if (!missing.length) return pass(`${expected.length} cron(s) in sync.`);
      const details = missing.map((m) => {
        const other = declared.find((d) => d.path === m.path);
        return other
          ? `${m.path}: schedule "${other.schedule}" ≠ "${m.schedule}"`
          : `${m.path} (${m.schedule}) missing`;
      });
      return fail(
        `${missing.length} job(s) from jobs.cron are not scheduled in the Vercel config; Vercel Cron never calls them.`,
        { details, fix: vercelJsonFix(ctx, expected) },
      );
    },
  },
  {
    id: 'vercel.cron-routes',
    title: 'Cron job routes export GET',
    category: 'vercel',
    severity: 'warn',
    run(ctx) {
      const expected = expectedVercelCrons(ctx);
      if (!expected.length) return skip('No cron jobs configured.');
      const problems: string[] = [];
      for (const cron of expected) {
        const file = routeHandlerFile(ctx.root, cron.path);
        if (!file) {
          problems.push(`${cron.path}: no app${cron.path}/route.ts found`);
          continue;
        }
        if (!exportsGet(readFileSync(file, 'utf8')))
          problems.push(`${rel(ctx.root, file)} does not export GET (Vercel Cron sends GET requests)`);
      }
      if (problems.length)
        return warn('Vercel Cron invokes job routes with GET and `Authorization: Bearer $CRON_SECRET`.', {
          details: problems,
        });
      return pass(`${expected.length} job route(s) export GET.`);
    },
  },
  {
    id: 'vercel.cron-secret',
    title: 'CRON_SECRET',
    category: 'vercel',
    severity: 'warn',
    run(ctx) {
      const hasCrons =
        expectedVercelCrons(ctx).length > 0 || (ctx.project.vercel.config?.crons.length ?? 0) > 0;
      const where = variableSource(ctx, 'CRON_SECRET');
      if (!hasCrons) return where ? pass(`CRON_SECRET available (${where}).`) : skip('No crons configured.');
      if (!where)
        return warn(
          'CRON_SECRET is not set; without it anyone can trigger the cron routes. Add it with `vercel env add CRON_SECRET` (at least 16 random characters) and pull it locally with `vercel env pull`.',
        );
      return pass(`CRON_SECRET available (${where}).`);
    },
  },
  {
    id: 'vercel.regions',
    title: 'Function region (US-first)',
    category: 'vercel',
    severity: 'warn',
    run(ctx) {
      const cfg = ctx.project.vercel.config;
      const regions = cfg?.regions ?? [];
      const perFunction = Object.entries(cfg?.functions ?? {}).filter(([, f]) => f.regions?.length);
      if (!regions.length && !perFunction.length)
        return pass(
          `No regions pinned (Vercel's default for new projects is ${VERCEL_DEFAULT_REGION}, Washington, D.C.).`,
        );
      const nonUs = [...regions, ...perFunction.flatMap(([, f]) => f.regions ?? [])].filter(
        (r) => !isUsRegion(r),
      );
      if (regions.length && !isUsRegion(regions[0]!))
        return warn(
          `regions start with "${regions[0]}"; HypDriv's defaults are US-first — place functions in ${VERCEL_DEFAULT_REGION} unless your data lives elsewhere.`,
          { details: nonUs.map((r) => `non-US region: ${r}`) },
        );
      if (regions.length && regions[0] !== VERCEL_DEFAULT_REGION)
        return info(
          `regions: ${regions.join(', ')} (US). ${VERCEL_DEFAULT_REGION} is the recommended default next to most US data stores.`,
        );
      if (nonUs.length)
        return info(
          `Primary region ${regions[0] ?? 'default'}; some functions pin non-US regions: ${[...new Set(nonUs)].join(', ')}.`,
        );
      return pass(`regions: ${regions.join(', ') || 'per function'}`);
    },
  },
  {
    id: 'vercel.proxy-runtime',
    title: 'proxy.ts runs on the Node.js runtime',
    category: 'vercel',
    severity: 'error',
    run(ctx) {
      const proxy = ctx.project.proxyFile;
      if (!proxy) return skip('no proxy.ts.');
      const source = readFileSync(proxy, 'utf8');
      if (
        /export\s+const\s+runtime\s*=\s*['"](?:edge|experimental-edge)['"]/.test(source) ||
        /runtime\s*:\s*['"](?:edge|experimental-edge)['"]/.test(source)
      ) {
        return fail(
          `${rel(ctx.root, proxy)} selects the Edge runtime; Next.js 16 proxy runs on Node.js and HypDriv's stages need it. Remove the runtime option.`,
        );
      }
      return pass(`${rel(ctx.root, proxy)} uses the Node.js runtime (Next.js 16 default for proxy).`);
    },
  },
  {
    id: 'vercel.runtime-package',
    title: 'HypDriv Vercel runtime',
    category: 'vercel',
    severity: 'info',
    run(ctx) {
      const v = ctx.project.hypdriv.packages['@hypdriv/vercel'];
      if (v) return pass(`@hypdriv/vercel ${v}`);
      return info(
        '@hypdriv/vercel is not installed; proxy.ts and the server helpers run the HypDriv stages. Install it for the Vercel-native cache, cron and runtime integrations when available.',
      );
    },
  },
  {
    id: 'vercel.cli',
    title: 'Vercel CLI and project link',
    category: 'vercel',
    severity: 'info',
    run(ctx) {
      const v = ctx.project.vercel;
      const parts: string[] = [];
      parts.push(v.cli ? `vercel ${v.cli}` : 'vercel CLI not installed locally (pnpm add -D vercel)');
      parts.push(v.linked ? 'project linked' : 'not linked (`vercel link`, then `vercel pull`)');
      if (v.cli && v.linked) return pass(parts.join(' · '));
      return info(parts.join(' · '));
    },
  },
  {
    id: 'vercel.output',
    title: 'Build Output API directory',
    category: 'vercel',
    severity: 'info',
    run(ctx) {
      const out = ctx.project.vercel.outputDir;
      if (!out)
        return info(
          'No .vercel/output yet; run `vercel build` before `hypdriv analyze` to measure the function bundles.',
        );
      const cfg = join(out, 'config.json');
      const buildId = ctx.project.nextBuild ? join(ctx.project.nextBuild.dir, 'BUILD_ID') : null;
      if (buildId && exists(buildId) && exists(cfg) && mtimeMs(buildId) > mtimeMs(cfg) + 1000)
        return warn('.next is newer than .vercel/output; run `vercel build` again before analysing.');
      return pass(`${rel(ctx.root, out)} present.`);
    },
  },
  {
    id: 'vercel.function-size',
    title: 'Function bundle sizes vs the 250 MB limit',
    category: 'vercel',
    severity: 'error',
    run(ctx) {
      const out = ctx.project.vercel.outputDir;
      const analysis =
        ctx.analyze?.vercel ?? (out ? analyzeVercelOutput(out, { buildRoot: ctx.root }) : null);
      if (!analysis) return skip('No .vercel/output; run `vercel build`.');
      if (!analysis.functions.length) return skip('No functions in .vercel/output (fully static build?).');
      const over = analysis.functions.filter((f) => f.status === 'error');
      const near = analysis.functions.filter((f) => f.status === 'warn');
      const largest = analysis.largest!;
      const line = (f: (typeof analysis.functions)[number]) =>
        `${f.name} (${f.routes.length} route${f.routes.length === 1 ? '' : 's'}, ${f.runtime}): ${(f.bytes / 1e6).toFixed(1)} MB${f.gzip !== null ? `, ${(f.gzip / 1e6).toFixed(2)} MB gzip` : ''} — ${(f.share * 100).toFixed(0)}% of the limit`;
      if (over.length)
        return fail(`${over.length} function(s) exceed Vercel's size limit.`, { details: over.map(line) });
      if (near.length)
        return warn(`${near.length} function(s) above 80% of the limit.`, { details: near.map(line) });
      return pass(`${analysis.functions.length} function(s); largest ${line(largest)}.`);
    },
  },
];

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { queueConsumerFor } from '@hypdriv/core';
import { BACKUP_SUFFIX } from '../../init/plan';
import { editWranglerJsonc } from '../../init/wrangler';
import { atLeast, monthsBetween } from '../../semver';
import { rel } from '../../util/fs';
import { envBindingGaps } from '../../wrangler-config';
import { type Check, type CheckContext, type CheckFix, fail, info, pass, skip, warn } from '../types';

export const MIN_COMPAT_DATE = '2024-09-23';
export const HYPDRIV_DO_CLASSES = ['HypDrivChannel', 'HypDrivLimiter', 'HypDrivIndex'];

function jsoncFix(
  ctx: CheckContext,
  description: string,
  options: Parameters<typeof editWranglerJsonc>[1],
): CheckFix | undefined {
  const w = ctx.project.wrangler;
  if (!w.configFile || w.format === 'toml')
    return { description: `${description} (edit wrangler.toml manually)` };
  const file = w.configFile;
  return {
    description,
    apply: () => {
      const source = readFileSync(file, 'utf8');
      const edit = editWranglerJsonc(source, options);
      if (!edit.changes.length) return;
      copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
      writeFileSync(file, edit.content);
    },
  };
}

function configuredCrons(ctx: CheckContext): string[] {
  return [...new Set(Object.values(ctx.config.resolved.jobs.cron).map((j) => j.cron))];
}

export const wranglerChecks: Check[] = [
  {
    id: 'wrangler.installed',
    title: 'wrangler installed',
    category: 'wrangler',
    severity: 'warn',
    run(ctx) {
      const v = ctx.project.wrangler.installed;
      if (!v)
        return warn(
          'wrangler is not installed (pnpm add -D wrangler); OpenNext and `hypdriv analyze` invoke it.',
        );
      if (!atLeast(v, '4.0.0'))
        return warn(
          `wrangler ${v} is older than 4.x; upgrade for current compatibility dates and JSONC config support.`,
        );
      return pass(`wrangler ${v}`);
    },
  },
  {
    id: 'wrangler.config',
    title: 'wrangler configuration file',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const w = ctx.project.wrangler;
      if (!w.configFile) {
        if (ctx.project.cloudflareConfigFile)
          return skip(
            `${rel(ctx.root, ctx.project.cloudflareConfigFile)} (cf CLI format) found; HypDriv inspects wrangler.jsonc only.`,
          );
        return fail(
          'No wrangler.jsonc / wrangler.json / wrangler.toml found; `hypdriv init` creates one for OpenNext Cloudflare.',
          { fix: { description: 'run `hypdriv init`' } },
        );
      }
      if (w.parseError)
        return fail(
          `${rel(ctx.root, w.configFile)}${w.environment ? ` (--env ${w.environment})` : ''} could not be read: ${w.parseError}`,
        );
      return pass(
        `${rel(ctx.root, w.configFile)} (${w.format})${w.environment ? `, checked as environment "${w.environment}" (name ${w.config?.name ?? 'unset'})` : ''}`,
      );
    },
  },
  {
    id: 'wrangler.env-bindings',
    title: 'environments repeat the bindings',
    category: 'wrangler',
    severity: 'warn',
    run(ctx) {
      const w = ctx.project.wrangler;
      if (!w.config) return skip('no wrangler config.');
      if (w.environment)
        return pass(
          `Checked as environment "${w.environment}", resolved the way Wrangler does (bindings of the top level are not inherited).`,
        );
      const envs = Object.keys(w.config.env);
      if (envs.length === 0) return pass('The config defines no environments.');
      const gaps = envBindingGaps(w.config);
      if (gaps.length === 0)
        return pass(
          `${envs.length} environment${envs.length === 1 ? '' : 's'} (${envs.join(', ')}) repeat every binding kind of the top level. Check each one with \`--env <name>\`.`,
        );
      return warn(
        `Wrangler does not inherit bindings into environments, so these deploy cleanly and run without them: ${gaps
          .map((g) => `env.${g.env} lacks ${g.missing.join(', ')}`)
          .join(
            '; ',
          )}. Repeat them per environment, then run \`hypdriv doctor --env <name>\` for each (doctor otherwise reads the top level only).`,
      );
    },
  },
  {
    id: 'wrangler.cloudflare-config',
    title: 'cloudflare.config.ts',
    category: 'wrangler',
    severity: 'info',
    run(ctx) {
      const file = ctx.project.cloudflareConfigFile;
      if (!file) return pass('Not using the cf CLI config format.');
      return info(
        `${rel(ctx.root, file)} detected (the new \`cf\` CLI). HypDriv reads wrangler.jsonc; keep main, compatibility settings and bindings in sync between the two.`,
      );
    },
  },
  {
    id: 'wrangler.main',
    title: 'Worker entry (main)',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      if (!cfg.main)
        return fail('wrangler config has no `main`; set it to hypdriv.worker.ts.', {
          fix: jsoncFix(ctx, 'set main to hypdriv.worker.ts', {
            main: 'hypdriv.worker.ts',
            observability: false,
          }),
        });
      if (/hypdriv\.worker\.(ts|mts|js|mjs)$/.test(cfg.main)) return pass(`main: ${cfg.main}`);
      return fail(
        `main is "${cfg.main}"; HypDriv's shell is bypassed until it points at hypdriv.worker.ts (which wraps .open-next/worker.js).`,
        {
          fix: jsoncFix(ctx, 'set main to hypdriv.worker.ts', {
            main: 'hypdriv.worker.ts',
            observability: false,
          }),
        },
      );
    },
  },
  {
    id: 'wrangler.nodejs-compat',
    title: 'nodejs_compat flag',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      if (
        cfg.compatibility_flags.includes('nodejs_compat') ||
        cfg.compatibility_flags.includes('nodejs_compat_v2')
      ) {
        const extra = cfg.compatibility_flags.filter((f) => f !== 'nodejs_compat');
        return pass(`nodejs_compat${extra.length ? ` (+ ${extra.join(', ')})` : ''}`);
      }
      return fail('compatibility_flags lacks "nodejs_compat"; Next.js on workerd requires it.');
    },
  },
  {
    id: 'wrangler.compatibility-date',
    title: 'compatibility_date',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const date = cfg.compatibility_date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return fail('compatibility_date is missing or malformed (expected YYYY-MM-DD).');
      if (date < MIN_COMPAT_DATE)
        return fail(
          `compatibility_date ${date} is older than ${MIN_COMPAT_DATE} (required by OpenNext for nodejs_compat v2 behaviour).`,
        );
      const parsed = new Date(`${date}T00:00:00Z`);
      if (parsed.getTime() > ctx.now.getTime() + 86400000)
        return warn(
          `compatibility_date ${date} is in the future; wrangler rejects dates newer than its runtime.`,
        );
      const months = monthsBetween(parsed, ctx.now);
      if (months > 6)
        return warn(
          `compatibility_date ${date} is ${months} months old; move it forward (first of the current month) to pick up runtime fixes.`,
        );
      return pass(`compatibility_date ${date}`);
    },
  },
  {
    id: 'wrangler.assets',
    title: 'Static assets binding',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const wanted = ctx.config.resolved.cloudflare.bindings.assets;
      if (!cfg.assets)
        return fail(
          'No `assets` block; OpenNext needs `"assets": { "directory": ".open-next/assets", "binding": "ASSETS" }`.',
        );
      const problems: string[] = [];
      // Wrangler resolves `directory` against the config file, which may live outside the project (`--wrangler`).
      const configDir = ctx.project.wrangler.configFile ? dirname(ctx.project.wrangler.configFile) : ctx.root;
      const directory = cfg.assets.directory ? resolve(configDir, cfg.assets.directory) : null;
      if (directory !== resolve(ctx.root, '.open-next/assets'))
        problems.push(`directory is "${cfg.assets.directory ?? ''}" (expected .open-next/assets)`);
      if (cfg.assets.binding !== wanted)
        problems.push(`binding is "${cfg.assets.binding ?? ''}" (expected ${wanted})`);
      if (problems.length) return warn(`assets: ${problems.join('; ')}.`);
      return pass(`assets ${cfg.assets.directory} → ${cfg.assets.binding}`);
    },
  },
  {
    id: 'wrangler.run-worker-first',
    title: 'run_worker_first',
    category: 'wrangler',
    severity: 'info',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const rwf = cfg.assets?.run_worker_first;
      if (rwf === true)
        return info(
          'assets.run_worker_first is true: every asset request runs the Worker (HypDriv headers on assets, higher cost). The public/_headers file covers immutable caching without it.',
        );
      if (Array.isArray(rwf) && rwf.length) return pass(`run_worker_first for ${rwf.length} pattern(s).`);
      return pass('Assets are served before the Worker runs.');
    },
  },
  {
    id: 'wrangler.self-reference',
    title: 'WORKER_SELF_REFERENCE service binding',
    category: 'wrangler',
    severity: 'warn',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const self = cfg.services.find((s) => s.binding === 'WORKER_SELF_REFERENCE');
      if (!self) {
        // Nothing revalidates without ISR routes or revalidation calls, so nothing needs the binding.
        const isr = ctx.manifest?.routes.filter((r) => r.classification === 'isr').length ?? null;
        const sources = ctx.project.sources;
        if (isr === 0 && sources.filesScanned > 0 && sources.revalidation.length === 0)
          return info(
            'No WORKER_SELF_REFERENCE service binding; not needed here (no ISR routes and no revalidateTag / revalidatePath / "use cache" in the sources). Add it before using them.',
          );
        return warn(
          'No WORKER_SELF_REFERENCE service binding; OpenNext uses it for ISR revalidation and queue dispatch (`"services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "<worker name>" }]`).',
        );
      }
      if (cfg.name && self.service !== cfg.name)
        return warn(
          `WORKER_SELF_REFERENCE points at "${self.service}" but the Worker is named "${cfg.name}".`,
        );
      return pass(`WORKER_SELF_REFERENCE → ${self.service}`);
    },
  },
  {
    id: 'wrangler.observability',
    title: 'Workers observability',
    category: 'wrangler',
    severity: 'warn',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      if (cfg.observability?.enabled === true || cfg.observability?.logs?.enabled === true)
        return pass('observability enabled (Workers Logs receive the structured logs).');
      return warn(
        'observability is not enabled; HypDriv logs and console spans are dropped. Add `"observability": { "enabled": true }`.',
        {
          fix: jsoncFix(ctx, 'enable observability', {
            main: cfg.main ?? 'hypdriv.worker.ts',
            observability: true,
          }),
        },
      );
    },
  },
  {
    id: 'wrangler.crons',
    title: 'Cron triggers match jobs.cron',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const crons = configuredCrons(ctx);
      const cfg = ctx.project.wrangler.config;
      if (!crons.length) return pass('No cron jobs configured.');
      if (!cfg) return skip('no wrangler config.');
      const declared = cfg.triggers?.crons ?? [];
      const missing = crons.filter((c) => !declared.includes(c));
      const extra = declared.filter((c) => !crons.includes(c));
      if (missing.length) {
        return fail(
          `triggers.crons lacks ${missing.map((c) => `"${c}"`).join(', ')}; the scheduled handler never fires for those jobs.`,
          {
            fix: jsoncFix(ctx, `add ${missing.length} cron trigger(s)`, {
              main: cfg.main ?? 'hypdriv.worker.ts',
              observability: false,
              crons,
            }),
          },
        );
      }
      if (extra.length)
        return info(
          `All job crons are declared; ${extra.length} extra trigger(s) without a job: ${extra.join(', ')}.`,
        );
      return pass(`${crons.length} cron trigger(s) in sync.`);
    },
  },
  {
    id: 'wrangler.queues',
    title: 'Queue consumers and producers match jobs.queues',
    category: 'wrangler',
    severity: 'warn',
    run(ctx) {
      const resolved = ctx.config.resolved;
      const jobs = Object.keys(resolved.jobs.queues);
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return jobs.length ? skip('no wrangler config.') : pass('No queue consumers configured.');
      const consumers = cfg.queues.consumers
        .map((c) => c.queue)
        .filter((q): q is string => typeof q === 'string' && !!q);
      if (!jobs.length && !consumers.length) return pass('No queue consumers configured.');
      const problems: string[] = [];
      const served = new Set<string>();
      for (const queue of consumers) {
        const match = queueConsumerFor(resolved, queue);
        if (match) served.add(match.name);
        else
          problems.push(
            `consumer queue "${queue}" maps to no jobs.queues entry: its batches are retried until they land in the dead-letter queue (add the job, or list "${queue}" in a job's \`queues\`).`,
          );
      }
      for (const job of jobs)
        if (!served.has(job))
          problems.push(
            `jobs.queues.${job} has no queues.consumers entry (${resolved.jobs.queues[job]!.queues.join(', ')}); batches never reach ${resolved.jobs.queues[job]!.path}.`,
          );
      const producers = new Set(cfg.queues.producers.map((p) => p.binding).filter(Boolean));
      for (const [job, binding] of Object.entries(resolved.cloudflare.bindings.queues))
        if (!producers.has(binding))
          problems.push(
            `cloudflare.bindings.queues.${job} → ${binding}, but no queues.producers entry binds ${binding}; enqueue("${job}") falls back to calling the consumer route inline.`,
          );
      if (problems.length)
        return warn(`${problems.length} queue configuration issue(s).`, { details: problems });
      return pass(`${jobs.length} queue job(s) consumed (${consumers.length} queue(s)).`);
    },
  },
  {
    id: 'wrangler.do-migrations',
    title: 'Durable Object migrations',
    category: 'wrangler',
    severity: 'error',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const classes = cfg.durable_objects.bindings
        .map((b) => b.class_name)
        .filter((c): c is string => typeof c === 'string' && !!c);
      const own = classes.filter(
        (c) => !cfg.durable_objects.bindings.find((b) => b.class_name === c)?.script_name,
      );
      if (!own.length)
        return pass(
          classes.length
            ? 'Durable Object bindings reference other scripts.'
            : 'No Durable Object bindings declared.',
        );
      const migrated = new Set<string>();
      for (const m of cfg.migrations)
        for (const c of [...(m.new_classes ?? []), ...(m.new_sqlite_classes ?? [])]) migrated.add(c);
      const missing = own.filter((c) => !migrated.has(c));
      if (missing.length)
        return fail(
          `Durable Object class(es) without a migration: ${missing.join(', ')}. Add \`"migrations": [{ "tag": "v1", "new_sqlite_classes": [${missing.map((c) => `"${c}"`).join(', ')}] }]\`.`,
        );
      return pass(`${own.length} Durable Object class(es) migrated.`);
    },
  },
  {
    id: 'wrangler.bindings',
    title: 'Optional HypDriv bindings',
    category: 'wrangler',
    severity: 'info',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const b = ctx.config.resolved.cloudflare.bindings;
      const have = (name: string) =>
        cfg.kv_namespaces.some((k) => k.binding === name) ||
        cfg.durable_objects.bindings.some((d) => d.name === name) ||
        cfg.analytics_engine_datasets.some((a) => a.binding === name) ||
        cfg.ratelimits.some((r) => r.name === name) ||
        cfg.images?.binding === name ||
        cfg.services.some((s) => s.binding === name);
      const table: Array<[string, string, string]> = [
        [b.kv, 'KV', 'global cache tier, tag index, KV redirects/flags'],
        [b.tagIndex, 'Durable Object', 'exact tag purge index'],
        [b.limiter, 'Durable Object', 'exact global rate limiting'],
        [b.channel, 'Durable Object', 'live channels'],
        [b.rateLimit, 'Rate Limiting', 'cheap per-colo limits'],
        [b.analyticsEngine, 'Analytics Engine', 'vitals, CSP reports, traces (`hypdriv vitals`)'],
        [b.images, 'Images', '/_next/image through the Images binding'],
      ];
      const present = table.filter(([name]) => have(name));
      const absent = table.filter(([name]) => !have(name));
      const details = absent.map(([name, kind, unlocks]) => `${name} (${kind}): ${unlocks}`);
      if (!present.length)
        return info(
          'No optional HypDriv bindings; everything runs on the zero-infrastructure baseline. Available upgrades:',
          { details },
        );
      return pass(
        `${present.map(([name]) => name).join(', ')} bound.${absent.length ? ` Not bound: ${absent.map(([n]) => n).join(', ')}.` : ''}`,
      );
    },
  },
  {
    id: 'wrangler.placement',
    title: 'Smart Placement',
    category: 'wrangler',
    severity: 'info',
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      if (cfg.placement?.mode === 'smart')
        return info(
          "Smart Placement moves the whole Worker (including HypDriv's edge stages) near your origin; prefer Hyperdrive for database proximity if edge latency matters.",
        );
      return pass('Worker runs at the edge.');
    },
  },
];

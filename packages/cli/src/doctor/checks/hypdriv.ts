import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editPackageJson, ensureHeadersRule } from '../../init/package-json';
import { devVarsExampleTemplate, HEADERS_RULE, scriptsTemplate } from '../../templates';
import { readText, rel, writeText } from '../../util/fs';
import { HYPDRIV_DO_CLASSES } from './wrangler';
import { type Check, fail, info, pass, skip, warn } from '../types';

const OPENNEXT_DO_CLASSES = ['DOQueueHandler', 'DOShardedTagCache', 'BucketCachePurge'];

function enabledSections(ctx: Parameters<Check['run']>[0]): string[] {
  const r = ctx.config.resolved;
  const out: string[] = [];
  if (r.security.csp) out.push(`csp:${r.security.csp.mode}${r.security.csp.reportOnly ? '/report-only' : ''}`);
  if (r.security.headers) out.push('headers');
  if (r.security.rateLimit.length) out.push(`rate-limit×${r.security.rateLimit.length}`);
  if (r.security.bots) out.push('bots');
  if (r.security.shield) out.push('shield');
  if (r.cache.edge) out.push(`edge-cache(${r.cache.edge.policies.length} policies${r.cache.edge.infer ? '+infer' : ''})`);
  if (r.performance.earlyHints) out.push('early-hints');
  if (r.performance.speculation) out.push('speculation');
  if (r.observe.tracing) out.push(`tracing:${r.observe.tracing.exporter}`);
  if (r.observe.vitals) out.push(`vitals:${r.observe.vitals.sink}`);
  if (Object.keys(r.flags.definitions).length) out.push(`flags×${Object.keys(r.flags.definitions).length}`);
  if (Object.keys(r.jobs.cron).length) out.push(`cron×${Object.keys(r.jobs.cron).length}`);
  if (r.purser) out.push(`purser:${String(r.purser.enabled)}`);
  return out;
}

export const hypdrivChecks: Check[] = [
  {
    id: 'hypdriv.installed',
    title: 'HypDriv packages installed',
    category: 'hypdriv',
    severity: 'error',
    run(ctx) {
      const h = ctx.project.hypdriv;
      if (!h.installed) return fail(h.range ? `hypdriv ${h.range} is declared but not installed; run the package manager install.` : 'hypdriv is not installed (pnpm add hypdriv).');
      const list = Object.entries(h.packages).map(([n, v]) => `${n}@${v}`);
      return pass(list.join(', '));
    },
  },
  {
    id: 'hypdriv.version-consistency',
    title: 'Matching @hypdriv versions',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const versions = new Set(Object.values(ctx.project.hypdriv.packages));
      if (versions.size === 0) return skip('no HypDriv packages installed.');
      if (versions.size > 1) return warn(`Mixed HypDriv versions installed (${[...versions].join(', ')}); the packages release in lockstep, align them.`);
      return pass(`All HypDriv packages at ${[...versions][0]}.`);
    },
  },
  {
    id: 'hypdriv.config-file',
    title: 'hypdriv.config present',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const file = ctx.project.hypdrivConfigFile;
      if (!file) return warn('No hypdriv.config.ts; defaults apply. `hypdriv init` writes one with commented options.', { fix: { description: 'run `hypdriv init`' } });
      return pass(rel(ctx.root, file));
    },
  },
  {
    id: 'hypdriv.config-valid',
    title: 'hypdriv.config loads and validates',
    category: 'hypdriv',
    severity: 'error',
    run(ctx) {
      if (!ctx.project.hypdrivConfigFile) return skip('no config file.');
      if (ctx.config.error) {
        if (/natively|strip-types/.test(ctx.config.error)) return skip(`Could not load the TypeScript config on Node ${ctx.project.node}: ${ctx.config.error}`);
        return fail(`hypdriv.config failed to load: ${ctx.config.error}`);
      }
      return pass(`valid — ${enabledSections(ctx).join(', ') || 'defaults'}`);
    },
  },
  {
    id: 'hypdriv.manifest',
    title: 'Build manifest',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const m = ctx.project.manifest;
      if (!m) return warn('No .hypdriv/manifest.json; run `next build` (with withHypDriv) so routes, CSP hashes and weights are known.');
      if (m.error) return fail(`.hypdriv/manifest.json is invalid: ${m.error}`);
      const d = m.data!;
      return pass(`build ${d.buildId} · ${d.routes.length} routes · Next ${d.nextVersion} · ${d.generatedAt}`);
    },
  },
  {
    id: 'hypdriv.manifest-version',
    title: 'Manifest written by the installed HypDriv',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const m = ctx.manifest;
      if (!m) return skip('no manifest.');
      const installed = ctx.project.hypdriv.packages['@hypdriv/next'] ?? ctx.project.hypdriv.installed;
      if (!installed) return skip('HypDriv is not installed.');
      if (m.hypdrivVersion === installed || m.hypdrivVersion.startsWith('0.0.0')) return pass(`manifest from HypDriv ${m.hypdrivVersion}.`);
      return warn(`manifest was written by HypDriv ${m.hypdrivVersion} but ${installed} is installed; rebuild.`);
    },
  },
  {
    id: 'hypdriv.manifest-build-id',
    title: 'Manifest matches .next/BUILD_ID',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const m = ctx.manifest;
      const build = ctx.project.nextBuild;
      if (!m || !build?.buildId) return skip('manifest or .next build missing.');
      if (m.buildId === build.buildId) return pass(`build ${m.buildId}`);
      return warn(`manifest build ${m.buildId} differs from .next/BUILD_ID ${build.buildId}; the last \`next build\` ran without the HypDriv adapter or the manifest is stale.`);
    },
  },
  {
    id: 'hypdriv.manifest-warnings',
    title: 'Build warnings',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const m = ctx.manifest;
      if (!m) return skip('no manifest.');
      if (!m.warnings.length) return pass('No warnings recorded at build time.');
      return warn(`${m.warnings.length} warning(s) from the last build.`, { details: m.warnings });
    },
  },
  {
    id: 'hypdriv.worker-entry',
    title: 'hypdriv.worker.ts',
    category: 'hypdriv',
    severity: 'error',
    run(ctx) {
      const file = ctx.project.hypdrivWorkerFile;
      if (!file) return fail('No hypdriv.worker.ts; `hypdriv init` writes the Worker entry that wraps .open-next/worker.js.', { fix: { description: 'run `hypdriv init`' } });
      const source = readFileSync(file, 'utf8');
      if (!/createWorker\s*\(/.test(source)) return warn(`${rel(ctx.root, file)} does not call createWorker() from hypdriv/cloudflare.`);
      const cfg = ctx.project.wrangler.config;
      const declared = cfg?.durable_objects.bindings.map((b) => b.class_name).filter((c): c is string => typeof c === 'string') ?? [];
      const missing = declared.filter((c) => (HYPDRIV_DO_CLASSES.includes(c) || OPENNEXT_DO_CLASSES.includes(c)) && !new RegExp(`\\b${c}\\b`).test(source));
      if (missing.length) return fail(`wrangler binds Durable Object class(es) the entry does not export: ${missing.join(', ')}. Export them from hypdriv.worker.ts.`);
      return pass(`${rel(ctx.root, file)} wraps OpenNext${declared.length ? ` and exports ${declared.length} Durable Object class(es)` : ''}.`);
    },
  },
  {
    id: 'hypdriv.headers-file',
    title: 'public/_headers immutable rule',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const file = join(ctx.root, 'public', '_headers');
      const existing = readText(file);
      const result = ensureHeadersRule(existing, HEADERS_RULE);
      if (!result.changed) return pass('public/_headers caches /_next/static/* immutably.');
      return warn(existing === null ? 'No public/_headers; /_next/static assets are served without the immutable Cache-Control rule.' : 'public/_headers lacks the immutable rule for /_next/static/*.', {
        fix: {
          description: 'write the /_next/static/* immutable rule to public/_headers',
          apply: () => writeText(file, result.content),
        },
      });
    },
  },
  {
    id: 'hypdriv.scripts',
    title: 'package.json scripts',
    category: 'hypdriv',
    severity: 'info',
    run(ctx) {
      const pkg = ctx.project.packageJson;
      if (!pkg) return skip('no package.json.');
      const wanted = scriptsTemplate();
      const missing = Object.keys(wanted).filter((s) => !pkg.scripts[s]);
      if (!missing.length) return pass('hypdriv:doctor, hypdriv:analyze, hypdriv:audit and cf-typegen present.');
      const file = join(ctx.root, 'package.json');
      return info(`Missing scripts: ${missing.join(', ')}.`, {
        fix: {
          description: `add ${missing.join(', ')} to package.json scripts`,
          apply: () => {
            const edit = editPackageJson(readFileSync(file, 'utf8'), { scripts: wanted });
            if (edit.changes.length) writeFileSync(file, edit.content);
          },
        },
      });
    },
  },
  {
    id: 'hypdriv.dev-vars-example',
    title: '.dev.vars.example',
    category: 'hypdriv',
    severity: 'info',
    run(ctx) {
      if (ctx.project.devVars.exampleFile) return pass('.dev.vars.example documents the expected secrets.');
      const file = join(ctx.root, '.dev.vars.example');
      return info('No .dev.vars.example; contributors have to guess which secrets `wrangler dev` needs.', {
        fix: { description: 'create .dev.vars.example', apply: () => (existsSync(file) ? undefined : writeText(file, devVarsExampleTemplate())) },
      });
    },
  },
  {
    id: 'hypdriv.devtools',
    title: 'DevTools HUD and Web Vitals in the root layout',
    category: 'hypdriv',
    severity: 'info',
    run(ctx) {
      const layout = ctx.project.layoutFile;
      if (!layout) return skip('no app/layout.tsx.');
      const source = readFileSync(layout, 'utf8');
      const hud = /HypDrivDevTools/.test(source);
      const vitals = /VitalsReporter/.test(source);
      if (hud && vitals) return pass('HypDrivDevTools and VitalsReporter are rendered.');
      const missing = [...(hud ? [] : ['<HypDrivDevTools />']), ...(vitals ? [] : ['<VitalsReporter />'])];
      return info(`Render ${missing.join(' and ')} from hypdriv/client in ${rel(ctx.root, layout)} for the HUD (Alt+Shift+H) and Web Vitals beacons.`);
    },
  },
];

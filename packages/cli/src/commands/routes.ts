import { frameworkLabel, manifestFramework } from '@hypdriv/core';
import { CliError, createContext } from '../context';
import { bytes } from '../ui';
import { type RouteRow, routeRows } from './route-rows';
import { diffFails, diffRoutes, type FailOn, loadBaseline, type RouteChange } from './routes-diff';
import { defineCommand } from './types';

export { type RouteRow, routeRows };

function revalidateLabel(v: RouteRow['revalidate']): string {
  if (v === null) return '—';
  if (v === false) return 'never';
  return `${v}s`;
}

export const routesCommand = defineCommand({
  name: 'routes',
  summary:
    'Table of routes from the manifest: classification, revalidate, cache policy, CSP mode, hints, JS/CSS, Purser atoms',
  usage:
    'hypdriv routes [--css] [--cache] [--csp] [--all] [--diff <manifest>] [--fail-on regress|change|never]',
  options: {
    css: { type: 'boolean', description: 'Add Purser atom counts and unused atoms' },
    cache: { type: 'boolean', description: 'Add cache policy details (ttl/swr/tags)' },
    csp: { type: 'boolean', description: 'Add CSP hash counts per route' },
    all: { type: 'boolean', description: 'Include _not-found and _global-error' },
    diff: {
      type: 'string',
      value: '<manifest>',
      description:
        'Compare with the manifest of an earlier build (a manifest.json, or a directory holding .hypdriv/manifest.json) and report routes that became more dynamic',
    },
    'fail-on': {
      type: 'string',
      value: 'regress|change|never',
      description: 'With --diff: exit 1 on regressions (default), on any change, or never',
    },
    weights: { type: 'boolean', description: 'With --diff: also compare client JS/CSS weights' },
    'weight-threshold': {
      type: 'string',
      value: '<percent>',
      description: 'With --diff --weights: relative change that counts (default 10)',
    },
  },
  examples: [
    'hypdriv routes',
    'hypdriv routes --css --json',
    'hypdriv routes --diff ../main-build/.hypdriv/manifest.json',
    'hypdriv routes --diff baseline.json --fail-on change --json',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const manifest = ctx.requireManifest();
    const baselinePath = args.string('diff');
    if (baselinePath !== undefined) return runDiff(ctx, manifest, baselinePath);
    const config = await ctx.loadConfig();
    const rows = routeRows(manifest, { all: args.boolean('all') });
    const policies = new Map((config.resolved.cache.edge?.policies ?? []).map((p) => [p.id, p]));
    const inferred = config.resolved.cache.edge?.inferredStatic;
    if (args.json) {
      ctx.ui.printJson({
        buildId: manifest.buildId,
        nextVersion: manifest.nextVersion ?? null,
        framework: manifestFramework(manifest),
        cacheComponents: manifest.cacheComponents,
        routes: rows.map((r) => ({
          ...r,
          ...(args.boolean('csp')
            ? {
                cspHashes: manifest.csp[r.id]
                  ? {
                      scripts: manifest.csp[r.id]!.scriptHashes.length,
                      styles: manifest.csp[r.id]!.styleHashes.length,
                    }
                  : null,
              }
            : {}),
          ...(args.boolean('cache') && r.cachePolicy
            ? { policy: policyDetail(r.cachePolicy, policies, inferred) }
            : {}),
          ...(args.boolean('css') && manifest.purser
            ? { atomList: manifest.purser.atomsByRoute[r.id] ?? [] }
            : {}),
        })),
        ...(args.boolean('css') && manifest.purser
          ? {
              purser: {
                stylesheet: manifest.purser.stylesheet,
                atoms: manifest.purser.atoms,
                unusedAtoms: manifest.purser.unusedAtoms,
                missingAtoms: manifest.purser.missingAtoms,
              },
            }
          : {}),
      });
      return 0;
    }
    const { ui } = ctx;
    ui.heading(
      `Routes — build ${manifest.buildId} · ${frameworkLabel(manifest)} · ${rows.length} routes${manifest.cacheComponents ? ' · Cache Components on' : ''}`,
    );
    const columns: Array<string | { header: string; align?: 'left' | 'right' }> = [
      'route',
      'kind',
      'class',
      'revalidate',
      'cache policy',
      'csp',
      { header: 'hints', align: 'right' },
      { header: 'JS', align: 'right' },
      { header: 'CSS', align: 'right' },
    ];
    if (args.boolean('css')) columns.push({ header: 'atoms', align: 'right' });
    if (args.boolean('csp')) columns.push({ header: 'hashes', align: 'right' });
    if (args.boolean('cache')) columns.push('ttl/swr');
    ui.table(
      rows.map((r) => {
        const cells: Array<string | number> = [
          r.route,
          r.kind,
          r.classification + (r.prerenderedPaths && r.prerenderedPaths > 0 ? ` (${r.prerenderedPaths})` : ''),
          revalidateLabel(r.revalidate),
          r.cachePolicy ?? '—',
          r.csp === 'none' ? '—' : r.csp,
          r.hints,
          bytes(r.js),
          bytes(r.css),
        ];
        if (args.boolean('css')) cells.push(r.atoms === null ? '—' : r.atoms);
        if (args.boolean('csp'))
          cells.push(
            manifest.csp[r.id]
              ? `${manifest.csp[r.id]!.scriptHashes.length}+${manifest.csp[r.id]!.styleHashes.length}`
              : '—',
          );
        if (args.boolean('cache')) {
          const d = r.cachePolicy ? policyDetail(r.cachePolicy, policies, inferred) : null;
          cells.push(d ? `${d.ttl}s/${d.swr}s${d.tags.length ? ` [${d.tags.join(',')}]` : ''}` : '—');
        }
        return cells;
      }),
      { columns },
    );
    if (args.boolean('css')) {
      ui.line();
      if (!manifest.purser) ui.note('No Purser section in the manifest (Purser inactive at build time).');
      else {
        ui.kv([
          [
            'stylesheet',
            `${manifest.purser.stylesheet} (${manifest.purser.atoms} atoms, hash ${manifest.purser.stylesheetHash})`,
          ],
          [
            'unused atoms',
            manifest.purser.unusedAtoms.length
              ? manifest.purser.unusedAtoms.slice(0, 40).join(' ') +
                (manifest.purser.unusedAtoms.length > 40 ? ' …' : '')
              : 'none',
          ],
          ['missing atoms', Object.values(manifest.purser.missingAtoms).flat().length || 'none'],
        ]);
      }
    }
    if (manifest.warnings.length) {
      ui.line();
      for (const w of manifest.warnings) ui.warn(w);
    }
    return 0;
  },
});

function policyDetail(
  id: string,
  policies: Map<string, { ttl: number; swr: number; tags: string[]; staleIfError: number }>,
  inferred: { ttl: number; swr: number; staleIfError: number } | undefined,
): {
  ttl: number;
  swr: number;
  staleIfError: number;
  tags: string[];
  source: 'explicit' | 'inferred';
} | null {
  const p = policies.get(id);
  if (p) return { ttl: p.ttl, swr: p.swr, staleIfError: p.staleIfError, tags: p.tags, source: 'explicit' };
  if (id.startsWith('inferred:') && inferred)
    return { ...inferred, tags: [`route:${id.slice('inferred:'.length)}`], source: 'inferred' };
  return null;
}

const FAIL_ON: readonly FailOn[] = ['regress', 'change', 'never'];

function runDiff(
  ctx: ReturnType<typeof createContext>,
  manifest: ReturnType<ReturnType<typeof createContext>['requireManifest']>,
  baselinePath: string,
): number {
  const { args, ui } = ctx;
  const failOn = (args.string('fail-on') ?? 'regress') as FailOn;
  if (!FAIL_ON.includes(failOn)) throw new CliError(`--fail-on must be one of ${FAIL_ON.join(', ')}.`, 2);
  const threshold = args.number('weight-threshold', 10, { min: 0, max: 1000 });
  const baseline = loadBaseline(baselinePath, ctx.io.cwd);
  const diff = diffRoutes(baseline, manifest, {
    all: args.boolean('all'),
    weights: args.boolean('weights'),
    weightThreshold: threshold,
  });
  const fails = diffFails(diff, failOn);
  const describe = (m: typeof manifest) => ({
    buildId: m.buildId,
    framework: manifestFramework(m),
  });
  if (args.json) {
    ui.printJson({
      baseline: describe(baseline),
      current: describe(manifest),
      failOn,
      failed: fails,
      summary: diff.summary,
      changes: diff.changes,
    });
    return fails ? 1 : 0;
  }
  ui.heading(
    `Route diff — baseline ${baseline.buildId} (${frameworkLabel(baseline)}) → build ${manifest.buildId} (${frameworkLabel(manifest)})`,
  );
  if (diff.changes.length === 0) {
    ui.status('pass', `No route changes (${diff.summary.unchanged} routes compared).`);
    return 0;
  }
  const section = (title: string, rows: RouteChange[]) => {
    if (rows.length === 0) return;
    ui.line();
    ui.subheading(`${title} (${rows.length})`);
    ui.table(
      rows.map((c) => [c.route, c.kind, c.from, '→', c.to]),
      { columns: ['route', 'change', 'from', '', 'to'] },
    );
    for (const c of rows) if (c.note) ui.note(`${c.route}: ${c.note}`);
  };
  section(
    'Regressions',
    diff.changes.filter((c) => c.severity === 'regression'),
  );
  section(
    'Improvements',
    diff.changes.filter((c) => c.severity === 'improvement'),
  );
  section(
    'Other changes',
    diff.changes.filter((c) => c.severity === 'info'),
  );
  ui.line();
  const { regressions, improvements, added, removed, unchanged } = diff.summary;
  ui.status(
    fails ? 'fail' : regressions > 0 ? 'warn' : 'pass',
    `${regressions} regression${regressions === 1 ? '' : 's'}, ${improvements} improvement${improvements === 1 ? '' : 's'}, ${added} added, ${removed} removed, ${unchanged} unchanged.`,
  );
  return fails ? 1 : 0;
}

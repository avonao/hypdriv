import { UsageError } from '../args';
import { createContext } from '../context';
import { fetchPackageInfos } from '../deps/registry';
import { applyUpdates, buildDepsReport, type UpdateMode } from '../deps/report';
import { readWorkspace } from '../deps/workspace';
import { installCommand } from '../project';
import { rel } from '../util/fs';
import { defineCommand } from './types';

export const depsCommand = defineCommand({
  name: 'deps',
  summary:
    'Dependency freshness across the workspace (npm registry): patch/minor/major classification and safe updates',
  usage: 'hypdriv deps [--update safe|major] [--only <name>] [--workspace] [--dry-run]',
  options: {
    update: {
      type: 'string',
      value: '<safe|major>',
      description: 'Rewrite ranges: safe = patch/minor; major requires --only',
    },
    only: {
      type: 'string',
      value: '<names>',
      description: 'Restrict to these dependencies (comma-separated)',
      multiple: true,
    },
    workspace: {
      type: 'boolean',
      description: 'Include every workspace package (default when pnpm-workspace.yaml exists at --root)',
    },
    'no-workspace': { type: 'boolean', description: 'Only the package at --root' },
    'dry-run': { type: 'boolean', description: 'With --update: show the changes without writing' },
    registry: {
      type: 'string',
      value: '<url>',
      description: 'Registry URL (default: npm_config_registry or https://registry.npmjs.org)',
    },
  },
  examples: [
    'hypdriv deps',
    'hypdriv deps --json > deps-report.json',
    'hypdriv deps --update safe',
    'hypdriv deps --update major --only next',
  ],
  details:
    'JSON shape: { generatedAt, packages: [{ name, path, outdated: [{ name, current, latest, diff, dev }] }] } (consumed by scripts/deps-summary.mjs).',
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const update = args.string('update') as UpdateMode | undefined;
    if (update !== undefined && update !== 'safe' && update !== 'major')
      throw new UsageError('--update must be safe or major');
    const only = args.list('only');
    if (update === 'major' && !only.length)
      throw new UsageError('--update major requires --only <name> (review each major upgrade individually)');
    const workspace = readWorkspace(ctx.root, { includeWorkspace: !args.boolean('no-workspace') });
    const names = [...new Set(workspace.packages.flatMap((p) => p.dependencies.map((d) => d.name)))].filter(
      (n) => !only.length || only.includes(n),
    );
    const registry = args.string('registry') ?? io.env.npm_config_registry ?? io.env.NPM_CONFIG_REGISTRY;
    const infos = await fetchPackageInfos(names, {
      fetch: io.fetch,
      concurrency: 8,
      ...(registry ? { registry } : {}),
    });
    const report = buildDepsReport(workspace, infos, { only, generatedAt: io.date().toISOString() });
    const allFailed = names.length > 0 && Object.keys(report.errors).length === names.length;
    const changes = update
      ? applyUpdates(workspace, report, update, { only, dryRun: args.boolean('dry-run') })
      : [];
    const install = installCommand(ctx.project({ scan: false }).packageManager);

    if (args.json) {
      ui.printJson({
        ...report,
        ...(update
          ? {
              update: {
                mode: update,
                dryRun: args.boolean('dry-run'),
                changes: changes.map((c) => ({ ...c, file: rel(ctx.root, c.file) })),
              },
            }
          : {}),
      });
      return allFailed ? 1 : 0;
    }
    const outdated = report.packages.flatMap((p) => p.outdated.map((o) => ({ pkg: p, o })));
    ui.heading(
      `Dependency freshness — ${workspace.packages.length} package(s), ${names.length} dependencies`,
    );
    if (!outdated.length) ui.status('pass', 'Everything is current.');
    else {
      const color = (d: string) =>
        d === 'major'
          ? ui.color.red(d)
          : d === 'minor'
            ? ui.color.yellow(d)
            : d === 'patch'
              ? ui.color.green(d)
              : ui.color.gray(d);
      ui.table(
        outdated
          .sort(
            (a, b) =>
              ['major', 'minor', 'patch', 'unknown'].indexOf(a.o.diff) -
                ['major', 'minor', 'patch', 'unknown'].indexOf(b.o.diff) || a.o.name.localeCompare(b.o.name),
          )
          .map(({ pkg, o }) => [
            pkg.path === '.' ? `${pkg.name} (root)` : pkg.path,
            o.name + (o.dev ? ui.color.dim(' dev') : ''),
            o.catalog
              ? `${o.current} ${ui.color.dim(`catalog:${o.catalog === 'default' ? '' : o.catalog}`)}`
              : o.current,
            o.latest,
            color(o.diff),
          ]),
        { columns: ['package', 'dependency', 'current', 'latest', 'update'] },
      );
      const counts = { major: 0, minor: 0, patch: 0 } as Record<string, number>;
      for (const { o } of outdated) counts[o.diff] = (counts[o.diff] ?? 0) + 1;
      ui.line();
      ui.line(`${counts.major ?? 0} major · ${counts.minor ?? 0} minor · ${counts.patch ?? 0} patch`);
    }
    const errors = Object.entries(report.errors);
    if (errors.length)
      ui.warn(
        `${errors.length} lookup(s) failed: ${errors
          .slice(0, 5)
          .map(([n, e]) => `${n} (${e})`)
          .join(', ')}${errors.length > 5 ? ' …' : ''}`,
      );
    if (update) {
      ui.heading(`${args.boolean('dry-run') ? 'Would update' : 'Updated'} (${update})`);
      if (!changes.length) ui.note('No eligible updates.');
      for (const c of changes) ui.line(`  ${rel(ctx.root, c.file)}  ${c.name}: ${c.from} → ${c.to}`);
      if (changes.length && !args.boolean('dry-run'))
        ui.note(`\nRun \`${install}\` to refresh the lockfile, then build and test.`);
    } else if (outdated.some(({ o }) => o.diff === 'patch' || o.diff === 'minor'))
      ui.note(
        '\nApply patch/minor updates with `hypdriv deps --update safe`; majors one at a time with `--update major --only <name>`.',
      );
    return allFailed ? 1 : 0;
  },
});

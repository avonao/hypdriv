import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type BudgetResult, evaluateBudgets } from '@hypdriv/core';
import { writeManifest } from '@hypdriv/core/node';
import { parseMetafile, summarizeMetafile } from '../analyze/metafile';
import { parseSourceMap, type SourceMapV3 } from '../analyze/sourcemap';
import { analyzeVercelOutput, type VercelAnalysis } from '../analyze/vercel';
import {
  type AnalyzeSnapshot,
  analyzeWorkerBundle,
  parseWranglerSizes,
  routeWeights,
  toWorkerWeight,
  WORKER_SIZE_LIMIT,
  type WorkerAnalysis,
  writeAnalyzeSnapshot,
} from '../analyze/weights';
import { CliError, createContext } from '../context';
import { execCommand } from '../project';
import { bytes, percent, type Ui } from '../ui';
import { exists, mtimeMs, readJsonFile, rel } from '../util/fs';
import { defineCommand } from './types';

export const WORKER_BUILD_DIR = '.hypdriv/worker-build';
const METAFILE = '.open-next/server-functions/default/handler.mjs.meta.json';

interface BundleFiles {
  js: string;
  map: string | null;
}

/** Largest `.js` in the dry-run output directory plus its map. */
export function findBundle(dir: string): BundleFiles | null {
  if (!exists(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  } catch {
    return null;
  }
  if (!entries.length) return null;
  const js = entries.map((f) => join(dir, f)).sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
  const map = exists(`${js}.map`) ? `${js}.map` : null;
  return { js, map };
}

function loadMetafile(root: string) {
  const file = join(root, METAFILE);
  const json = readJsonFile(file);
  const meta = json ? parseMetafile(json) : null;
  return meta ? summarizeMetafile(meta, rel(root, file)) : null;
}

export const analyzeCommand = defineCommand({
  name: 'analyze',
  summary: 'Worker weight report (bundle + source map attribution), per-route client JS/CSS and budgets',
  usage: 'hypdriv analyze [--worker] [--routes] [--no-build] [--top <n>] [--platform cloudflare|vercel]',
  options: {
    worker: { type: 'boolean', description: 'Only the Worker report' },
    routes: { type: 'boolean', description: 'Only the per-route report' },
    'no-build': { type: 'boolean', description: 'Never run wrangler; use an existing dry-run bundle' },
    top: { type: 'string', value: '<n>', description: 'Modules to list', default: '25' },
  },
  examples: [
    'hypdriv analyze',
    'hypdriv analyze --worker --no-build',
    'hypdriv analyze --json > analyze.json',
  ],
  details:
    'Cloudflare: reuses .hypdriv/worker-build when it is newer than .open-next/worker.js, otherwise runs `wrangler deploy --dry-run --outdir .hypdriv/worker-build`.\nVercel: measures every function in .vercel/output (run `vercel build` first, or let analyze run it in a linked project) against the 250 MB uncompressed limit.',
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const project = ctx.project({ scan: false });
    const config = await ctx.loadConfig();
    const manifest = ctx.manifest();
    const wantWorker = !args.boolean('routes');
    const wantRoutes = !args.boolean('worker');
    const top = args.number('top', 25, { min: 1, max: 200 });
    const notes: string[] = [];
    let worker: WorkerAnalysis | null = null;
    let vercel: VercelAnalysis | null = null;
    const platform = project.platform;

    if (wantWorker && platform === 'vercel') {
      let outputDir = project.vercel.outputDir;
      if (!outputDir && !args.boolean('no-build')) {
        if (!project.vercel.linked) {
          notes.push(
            'No .vercel/output and the project is not linked; run `vercel link && vercel pull --yes && vercel build`, then analyze again.',
          );
        } else {
          const cmd = execCommand(project.packageManager, 'vercel', ['build']);
          ui.note(`$ ${cmd.command} ${cmd.args.join(' ')}`);
          // In a monorepo the link (and `vercel build`) lives at the repository root.
          const linkDir = project.vercel.linkDir ?? project.root;
          const result = await io.exec(cmd.command, cmd.args, {
            cwd: linkDir,
            timeoutMs: 20 * 60_000,
            env: { CI: '1' },
          });
          if (result.code !== 0) {
            const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n');
            throw new CliError(`vercel build failed (exit ${result.code}):\n${tail}`);
          }
          outputDir = exists(join(linkDir, '.vercel', 'output')) ? join(linkDir, '.vercel', 'output') : null;
        }
      } else if (!outputDir)
        notes.push('No .vercel/output and --no-build was given; run `vercel build` for the function report.');
      if (outputDir) {
        const buildId = project.nextBuild ? join(project.nextBuild.dir, 'BUILD_ID') : null;
        if (buildId && exists(buildId) && mtimeMs(buildId) > mtimeMs(join(outputDir, 'config.json')) + 1000)
          notes.push(
            '.next is newer than .vercel/output; the function report may be stale (run `vercel build`).',
          );
        vercel = analyzeVercelOutput(outputDir, { buildRoot: project.root });
        if (config.resolved.budgets.worker.raw !== null || config.resolved.budgets.worker.gzip !== null)
          notes.push(
            'budgets.worker applies to the Cloudflare Worker bundle; on Vercel each function is checked against the 250 MB limit instead.',
          );
      }
    } else if (wantWorker && platform !== 'cloudflare' && !project.openNextWorkerFile) {
      notes.push(
        `Platform ${platform}: no server bundle to measure (Worker reports need .open-next/, Vercel reports need .vercel/output). Use --platform to choose.`,
      );
    } else if (wantWorker) {
      const outDir = join(project.root, WORKER_BUILD_DIR);
      const openNext = project.openNextWorkerFile;
      let bundle = findBundle(outDir);
      const fresh =
        bundle && openNext
          ? mtimeMs(bundle.js) >= mtimeMs(openNext) &&
            (!project.hypdrivWorkerFile || mtimeMs(bundle.js) >= mtimeMs(project.hypdrivWorkerFile))
          : false;
      let wranglerReported: { total: number; gzip: number } | null = null;
      if (!openNext) {
        notes.push(
          'No .open-next/worker.js: run `opennextjs-cloudflare build` first; the Worker report is skipped.',
        );
        if (bundle) notes.push(`Using the stale dry-run bundle in ${WORKER_BUILD_DIR}.`);
      }
      if (openNext && (!bundle || !fresh)) {
        if (args.boolean('no-build')) {
          notes.push(
            bundle
              ? `Reusing ${WORKER_BUILD_DIR} although .open-next is newer (--no-build).`
              : `No dry-run bundle in ${WORKER_BUILD_DIR} and --no-build was given; Worker report skipped.`,
          );
        } else {
          const cmd = execCommand(project.packageManager, 'wrangler', [
            'deploy',
            '--dry-run',
            '--outdir',
            WORKER_BUILD_DIR,
          ]);
          ui.note(`$ ${cmd.command} ${cmd.args.join(' ')}`);
          // In a monorepo the link (and `vercel build`) lives at the repository root.
          const linkDir = project.vercel.linkDir ?? project.root;
          const result = await io.exec(cmd.command, cmd.args, {
            cwd: linkDir,
            timeoutMs: 10 * 60_000,
            env: { CI: '1', WRANGLER_SEND_METRICS: 'false' },
          });
          const output = `${result.stdout}\n${result.stderr}`;
          wranglerReported = parseWranglerSizes(output);
          if (result.code !== 0) {
            const tail = output.trim().split('\n').slice(-12).join('\n');
            throw new CliError(`wrangler deploy --dry-run failed (exit ${result.code}):\n${tail}`);
          }
          bundle = findBundle(outDir);
          if (!bundle)
            throw new CliError(`wrangler finished but no bundle was written to ${WORKER_BUILD_DIR}.`);
        }
      }
      if (bundle) {
        const code = readFileSync(bundle.js, 'utf8');
        let map: SourceMapV3 | null = null;
        if (bundle.map) {
          map = parseSourceMap(readFileSync(bundle.map, 'utf8'));
          if (!map)
            notes.push(
              `${rel(project.root, bundle.map)} is not a usable v3 source map; attribution skipped.`,
            );
        } else
          notes.push(
            'No source map next to the bundle (wrangler writes one with --outdir); attribution skipped.',
          );
        worker = analyzeWorkerBundle({
          file: rel(project.root, bundle.js),
          code,
          map,
          wranglerReported,
          metafile: loadMetafile(project.root),
          topModules: top,
          topPackages: 15,
        });
      }
    }

    const routes = manifest ? routeWeights(manifest) : [];
    if (wantRoutes && !manifest)
      notes.push('No .hypdriv/manifest.json; run `next build` for the per-route report.');
    const totalEntry = manifest?.budgets?.find((b) => b.id === 'total:js');
    const budgets: BudgetResult[] = evaluateBudgets(config.resolved.budgets, {
      routes: routes.map((r) => ({ id: r.id, pathname: r.pathname, js: r.js, css: r.css })),
      ...(worker ? { worker: { raw: worker.raw, gzip: worker.gzip } } : {}),
      ...(totalEntry ? { totalJs: totalEntry.actual } : {}),
    });

    const snapshot: AnalyzeSnapshot = {
      version: 1,
      generatedAt: io.date().toISOString(),
      buildId: manifest?.buildId ?? null,
      platform,
      worker,
      vercel,
      routes,
      budgets,
    };
    const snapshotFile = writeAnalyzeSnapshot(project.root, snapshot);
    if (manifest && worker) {
      await writeManifest(project.root, {
        ...manifest,
        weights: { ...manifest.weights, worker: toWorkerWeight(worker) },
        budgets,
      });
    }

    if (args.json) {
      ui.printJson({ ...snapshot, notes, files: { snapshot: rel(project.root, snapshotFile) } });
    } else {
      if (vercel) printVercel(ui, vercel, top);
      printAnalyze(ui, {
        worker,
        routes,
        budgets,
        notes,
        manifestUpdated: Boolean(manifest && worker),
        top,
        failOn: config.resolved.budgets.failOn,
      });
    }
    const over = budgets.some((b) => b.status === 'error');
    const functionOver = vercel?.functions.some((f) => f.status === 'error') ?? false;
    return (over && config.resolved.budgets.failOn === 'error') || functionOver ? 1 : 0;
  },
});

function printVercel(ui: Ui, analysis: VercelAnalysis, top: number): void {
  ui.heading(
    `Vercel functions  ${ui.color.dim(`${analysis.functions.length} bundle(s) · limit ${bytes(analysis.limit)} uncompressed`)}`,
  );
  if (!analysis.functions.length) ui.note('No functions in .vercel/output (fully static output).');
  else
    ui.table(
      analysis.functions.slice(0, top).map((f) => [
        ui.statusIcon(f.status === 'ok' ? 'pass' : f.status === 'warn' ? 'warn' : 'fail'),
        f.name,
        f.runtime,
        f.regions.join(',') || '—',
        String(f.files),
        bytes(f.bytes),
        f.gzip !== null ? bytes(f.gzip) : '—',
        percent(f.share),
        f.routes.length > 1 ? `${f.routes.length} routes` : (f.routes[0] ?? ''),
        f.topPackages
          .slice(0, 3)
          .map((p) => `${p.name} ${bytes(p.bytes)}`)
          .join(', '),
      ]),
      {
        columns: [
          '',
          { header: 'function', maxWidth: 40 },
          'runtime',
          'regions',
          { header: 'files', align: 'right' },
          { header: 'size', align: 'right' },
          { header: 'gzip', align: 'right' },
          { header: 'limit', align: 'right' },
          { header: 'routes', maxWidth: 30 },
          { header: 'largest packages', maxWidth: 70 },
        ],
      },
    );
  const missing = analysis.functions.reduce((n, f) => n + f.missingFiles, 0);
  if (missing)
    ui.warn(`${missing} traced file(s) from filePathMap were not found on disk; sizes are a lower bound.`);
  ui.kv([['static output', `${analysis.static.files} files · ${bytes(analysis.static.bytes)}`]]);
}

interface PrintInput {
  worker: WorkerAnalysis | null;
  routes: AnalyzeSnapshot['routes'];
  budgets: BudgetResult[];
  notes: string[];
  manifestUpdated: boolean;
  top: number;
  failOn: 'error' | 'warn' | 'never';
}

function printAnalyze(ui: Ui, input: PrintInput): void {
  const { worker } = input;
  if (worker) {
    ui.heading(`Worker bundle  ${ui.color.dim(worker.file)}`);
    ui.kv([
      ['raw', `${bytes(worker.raw)} (${percent(worker.raw / WORKER_SIZE_LIMIT)} of the 64 MiB limit)`],
      ['gzip', bytes(worker.gzip)],
      [
        'wrangler reported',
        worker.wranglerReported
          ? `${bytes(worker.wranglerReported.total)} / gzip ${bytes(worker.wranglerReported.gzip)}`
          : '—',
      ],
      ['top-level await', String(worker.topLevelAwaits)],
      [
        'source map',
        worker.sourceMap
          ? `yes · app code ${bytes(worker.appBytes)} · unmapped ${bytes(worker.unmapped)}`
          : 'no',
      ],
    ]);
    if (worker.largestModules.length) {
      ui.heading(`Largest modules (top ${Math.min(input.top, worker.largestModules.length)})`);
      ui.table(
        worker.largestModules.map((m) => [bytes(m.bytes), percent(m.share), m.source]),
        {
          columns: [
            { header: 'bytes', align: 'right' },
            { header: 'share', align: 'right' },
            { header: 'module', maxWidth: 110 },
          ],
        },
      );
    }
    if (worker.byPackage.length) {
      ui.heading('Largest packages');
      ui.table(
        worker.byPackage.map((p) => [bytes(p.bytes), percent(p.share), p.name]),
        { columns: [{ header: 'bytes', align: 'right' }, { header: 'share', align: 'right' }, 'package'] },
      );
    }
    if (worker.duplicates.length) {
      ui.heading('Duplicate packages');
      ui.table(
        worker.duplicates.map((d) => [d.name, d.versions.join(', ')]),
        { columns: ['package', { header: 'installations', maxWidth: 100 }] },
      );
    } else if (worker.sourceMap) ui.note('\nNo duplicate package installations in the bundle.');
    if (worker.metafile) {
      ui.heading(`OpenNext metafile  ${ui.color.dim(worker.metafile.file)}`);
      ui.table(
        worker.metafile.largestInputs.map((i) => [bytes(i.bytesInOutput || i.bytes), i.path]),
        {
          columns: [
            { header: 'bytes', align: 'right' },
            { header: 'input', maxWidth: 110 },
          ],
        },
      );
    }
  }
  if (input.routes.length) {
    ui.heading('Client assets per route (gzip)');
    ui.table(
      [...input.routes]
        .sort((a, b) => b.js - a.js)
        .map((r) => [r.pathname, r.classification, bytes(r.js), bytes(r.css)]),
      { columns: ['route', 'class', { header: 'JS', align: 'right' }, { header: 'CSS', align: 'right' }] },
    );
  }
  if (input.budgets.length) {
    ui.heading(`Budgets  ${ui.color.dim(`failOn: ${input.failOn}`)}`);
    for (const b of input.budgets) {
      const status = b.status === 'ok' ? 'pass' : b.status === 'warn' ? 'warn' : 'fail';
      ui.status(
        status,
        `${b.id}${b.target ? ` (${b.target})` : ''}`,
        `${b.metric === 'startupMs' ? `${b.actual} ms / ${b.limit} ms` : `${bytes(b.actual)} / ${bytes(b.limit)}`}`,
      );
    }
  }
  if (input.notes.length) {
    ui.line();
    for (const n of input.notes) ui.warn(n);
  }
  ui.line();
  ui.note(
    `Snapshot written to ${'.hypdriv/analyze.json'}${input.manifestUpdated ? '; manifest weights.worker updated' : ''}.`,
  );
}

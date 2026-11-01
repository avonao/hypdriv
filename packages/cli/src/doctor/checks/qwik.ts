import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedVersion } from '@hypdriv/core/node';
import { rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';

/** Where Qwik Router keeps its adapters' Vite configs (`adapters/<name>/vite.config.ts`). */
export const QWIK_ADAPTER_DIR = 'adapters';

/** Server entries that are not platform entries (`entry.ssr.tsx` renders, `entry.dev.tsx`/`entry.preview.tsx` serve). */
const NON_PLATFORM_ENTRIES = new Set(['ssr', 'dev', 'preview']);

const VERCEL_FUNCTION_DIR = '.vercel/output/functions/_qwik-router.func';

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Whether a Qwik version is one this Hypdriv release supports (`>=2.0.0-rc.4 <3`: Qwik v2 on Vite 8). */
export function qwikVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version);
  if (!match) return true;
  if (Number(match[1]) !== 2) return false;
  const pre = match[4];
  if (!pre) return true;
  if (Number(match[2]) > 0 || Number(match[3]) > 0) return true;
  // 2.0.0 alphas, betas and early release candidates predate the Vite 8 adapter API.
  const rc = /^rc\.(\d+)$/.exec(pre);
  return rc ? Number(rc[1]) >= 4 : false;
}

/** Whether the version is Qwik v1 (`@builder.io/qwik-city`), which has its own migration path. */
export const isQwikV1 = (version: string): boolean => /^1\./.test(version);

export type QwikWiring = 'hypdriv' | 'qwik' | 'none';

/**
 * Which adapter a `adapters/<name>/vite.config.*` uses: Hypdriv's (`@hypdriv/qwik/adapters/<target>`), Qwik's own
 * (`@qwik.dev/router/adapters/<name>/vite`: static generation and the platform files, but the server runs Qwik's
 * handler and Hypdriv's pipeline never does) or neither.
 */
export function adapterWiring(source: string): QwikWiring {
  const code = stripComments(source);
  if (/['"]@hypdriv\/qwik\/adapters\/(?:node|vercel|cloudflare)['"]/.test(code)) return 'hypdriv';
  if (/['"](?:@qwik\.dev\/router|@builder\.io\/qwik-city)\/adapters\/[\w-]+(?:\/vite)?['"]/.test(code))
    return 'qwik';
  return 'none';
}

/** Which request handler a server entry (`src/entry.<target>.tsx`) creates: Hypdriv's or Qwik's own. */
export function entryWiring(source: string): QwikWiring {
  const code = stripComments(source);
  if (/['"]@hypdriv\/qwik\/middleware\/(?:node|vercel|cloudflare)['"]/.test(code)) return 'hypdriv';
  if (/['"](?:@qwik\.dev\/router|@builder\.io\/qwik-city)\/middleware\/[\w-]+['"]/.test(code)) return 'qwik';
  return 'none';
}

/** Whether a Vercel adapter config builds the server into the Build Output function directory. */
export function vercelOutDir(source: string): boolean {
  const code = stripComments(source);
  return /\boutDir\s*:\s*['"`][^'"`]*\.vercel\/output\/functions\/[^'"`]+\.func['"`]/.test(code);
}

interface SourceFile {
  /** Relative to the project root. */
  file: string;
  source: string;
}

const CONFIG_FILE = /^vite\.config\.[cm]?[jt]s$/;
const ENTRY_FILE = /^entry\.([\w-]+)\.[jt]sx?$/;

/** The `adapters/<name>/vite.config.*` files of a project. */
export function adapterConfigs(root: string): SourceFile[] {
  const dir = join(root, QWIK_ADAPTER_DIR);
  if (!existsSync(dir)) return [];
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of readdirSync(join(dir, entry.name)).filter((f) => CONFIG_FILE.test(f))) {
      const path = join(dir, entry.name, name);
      files.push({ file: rel(root, path), source: readFileSync(path, 'utf8') });
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** The platform server entries in `src` (`entry.node.tsx`, `entry.cloudflare-pages.tsx`…). */
export function serverEntries(root: string): SourceFile[] {
  const dir = join(root, 'src');
  if (!existsSync(dir)) return [];
  const files: SourceFile[] = [];
  for (const name of readdirSync(dir)) {
    const match = ENTRY_FILE.exec(name);
    if (!match || NON_PLATFORM_ENTRIES.has(match[1] as string)) continue;
    files.push({ file: rel(root, join(dir, name)), source: readFileSync(join(dir, name), 'utf8') });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export const qwikChecks: Check[] = [
  {
    id: 'qwik.version',
    title: 'Supported Qwik version',
    category: 'qwik',
    severity: 'error',
    frameworks: ['qwik'],
    run(ctx) {
      const version = ctx.project.framework.version;
      if (!version) return skip('Qwik version unknown.');
      if (isQwikV1(version))
        return fail(
          `Qwik City ${version} (Qwik v1) is not supported: Hypdriv builds on Qwik v2's Vite 8 adapter API (@qwik.dev/core and @qwik.dev/router >=2.0.0-rc.4). Move the application with \`qwik migrate-v2\`.`,
        );
      if (!qwikVersionSupported(version))
        return fail(
          `Qwik ${version} is outside @hypdriv/qwik's range (>=2.0.0-rc.4 <3): earlier v2 pre-releases predate the adapter API Hypdriv wraps.`,
        );
      return /-/.test(version)
        ? info(`Qwik ${version} is a pre-release; Hypdriv follows Qwik v2 until its stable release.`)
        : pass(`Qwik ${version}.`);
    },
  },
  {
    id: 'qwik.vite',
    title: 'Vite 8',
    category: 'qwik',
    severity: 'warn',
    frameworks: ['qwik'],
    run(ctx) {
      const version = installedVersion(ctx.root, 'vite');
      if (!version) return skip('Vite is not installed.');
      const major = Number(/^(\d+)\./.exec(version)?.[1]);
      return major >= 8
        ? pass(`Vite ${version}.`)
        : warn(
            `Vite ${version}: @hypdriv/qwik and Qwik v2's adapters use Vite 8's Rolldown build (vite >=8).`,
          );
    },
  },
  {
    id: 'qwik.adapter',
    title: 'Hypdriv adapter builds the server',
    category: 'qwik',
    severity: 'error',
    frameworks: ['qwik'],
    run(ctx) {
      const configs = adapterConfigs(ctx.root);
      if (!configs.length)
        return warn(
          `No ${QWIK_ADAPTER_DIR}/<target>/vite.config.ts found: add the Hypdriv adapter of each target (@hypdriv/qwik/adapters/node, …/vercel, …/cloudflare); \`hypdriv init\` creates it.`,
        );
      const wired = configs.filter((c) => adapterWiring(c.source) === 'hypdriv');
      const own = configs.filter((c) => adapterWiring(c.source) === 'qwik');
      if (!wired.length)
        return fail(
          `${own.map((c) => c.file).join(', ') || configs.map((c) => c.file).join(', ')} ${own.length ? "uses Qwik's own adapter" : 'does not use a Hypdriv adapter'}: the build writes Hypdriv's manifest but the server never runs the pipeline. Use nodeAdapter(), vercelAdapter() or cloudflareAdapter() from '@hypdriv/qwik/adapters/<target>'.`,
        );
      return own.length
        ? info(
            `${wired.map((c) => c.file).join(', ')} use Hypdriv's adapter; ${own.map((c) => c.file).join(', ')} still use Qwik's own (builds with them run without the pipeline).`,
          )
        : pass(`${wired.map((c) => c.file).join(', ')} use Hypdriv's adapter.`);
    },
  },
  {
    id: 'qwik.entry',
    title: 'Server entry runs the Drivetrain',
    category: 'qwik',
    severity: 'error',
    frameworks: ['qwik'],
    run(ctx) {
      const entries = serverEntries(ctx.root);
      const wired = entries.filter((e) => entryWiring(e.source) === 'hypdriv');
      const own = entries.filter((e) => entryWiring(e.source) === 'qwik');
      if (!entries.length)
        return fail(
          'No server entry found in src (entry.node.tsx, entry.vercel.tsx or entry.cloudflare.tsx): create one with `createQwikRouter({ render })` from @hypdriv/qwik/middleware/<target>; `hypdriv init` creates it.',
        );
      if (!wired.length)
        return fail(
          `${(own.length ? own : entries).map((e) => e.file).join(', ')} ${own.length ? "creates Qwik's own request handler" : 'does not create the Hypdriv request handler'}, so the pipeline never runs: import createQwikRouter from '@hypdriv/qwik/middleware/<node|vercel|cloudflare>' instead.`,
        );
      return own.length
        ? info(
            `${wired.map((e) => e.file).join(', ')} run the Drivetrain; ${own.map((e) => e.file).join(', ')} still use Qwik's own handler.`,
          )
        : pass(`${wired.map((e) => e.file).join(', ')} run the Drivetrain.`);
    },
  },
  {
    id: 'qwik.worker',
    title: 'Worker serves the Qwik build',
    category: 'qwik',
    severity: 'warn',
    frameworks: ['qwik'],
    platforms: ['cloudflare'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const problems: string[] = [];
      if (!cfg.main || !/(^|\/)_worker\.js$/.test(cfg.main))
        problems.push(
          `main is ${cfg.main ?? 'not set'}; the Hypdriv Cloudflare adapter writes the Worker to "./dist/_worker.js"`,
        );
      const directory = cfg.assets?.directory;
      if (!directory || !/(^|\/)dist\/?$/.test(directory))
        problems.push(
          `assets.directory is ${directory ?? 'not set'}; the static client build is "./dist" (binding ASSETS)`,
        );
      if (problems.length) return warn(`${problems.join('; ')}.`);
      const first = cfg.assets?.run_worker_first;
      if (Array.isArray(first) && !first.some((p) => /^!\/build\//.test(p)))
        return info(
          'run_worker_first has no "!/build/*" exclusion, so every hashed file of the Qwik build invokes the Worker; use ["/*", "!/build/*", "!/assets/*"].',
        );
      return pass(`main ${cfg.main}, assets ${directory}.`);
    },
  },
  {
    id: 'qwik.vercel-outdir',
    title: 'Vercel adapter builds into the Build Output',
    category: 'qwik',
    severity: 'error',
    frameworks: ['qwik'],
    platforms: ['vercel'],
    run(ctx) {
      const vercel = adapterConfigs(ctx.root).filter((c) =>
        /@hypdriv\/qwik\/adapters\/vercel['"]/.test(c.source),
      );
      if (!vercel.length) return skip('no adapter config that uses @hypdriv/qwik/adapters/vercel.');
      const missing = vercel.filter((c) => !vercelOutDir(c.source));
      if (missing.length)
        return fail(
          `${missing.map((c) => c.file).join(', ')} does not set build.outDir to '${VERCEL_FUNCTION_DIR}': Qwik writes the server build where the config says, and Vercel only deploys .vercel/output.`,
        );
      return pass(`${vercel.map((c) => c.file).join(', ')} builds into ${VERCEL_FUNCTION_DIR}.`);
    },
  },
  {
    id: 'qwik.loader-json',
    title: 'Route loader data runs the pipeline',
    category: 'qwik',
    severity: 'info',
    frameworks: ['qwik'],
    platforms: ['cloudflare'],
    run(ctx) {
      if (ctx.config.resolved.cloudflare.skipStaticAssets === false)
        return pass(
          'cloudflare.skipStaticAssets is false: loader data requests run the stages like pages do.',
        );
      return info(
        'Qwik serves route loader data from `<page>/q-loader-<id>.<hash>.json`, which looks like a static file, so the Worker skips the pipeline for it (cloudflare.skipStaticAssets, default true). Set `cloudflare: { skipStaticAssets: false }` in hypdriv.config.ts to rate limit, shield and geo-route loader requests like page requests.',
      );
    },
  },
];

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HypManifest } from '@hypdriv/core';
import { configModuleCode, ensureAssetsIgnore, type LoadedHypConfig } from '@hypdriv/vite';
import type { SvelteKitCsp } from '../csp';

/** Where adapter-cloudflare writes its output, read from the wrangler config the same way the adapter does. */
export interface CloudflareLayout {
  /** Cloudflare Pages (`_worker.js` in advanced mode) rather than Workers with static assets. */
  pages: boolean;
  /** The static assets directory (`assets.directory`, `pages_build_output_dir` or `.svelte-kit/cloudflare`). */
  assetsDir: string;
  /** The Worker entry the adapter generated (`main`, or `_worker.js` in the assets directory). */
  workerFile: string;
  /** The wrangler config file, when one exists. */
  configPath: string | null;
}

/** The subset of wrangler's `Unstable_Config` the layout depends on. */
export interface WranglerConfigLike {
  configPath?: string | undefined;
  main?: string | undefined;
  pages_build_output_dir?: string | undefined;
  assets?: { directory?: string | undefined } | undefined;
}

/** adapter-cloudflare's `is_building_for_cloudflare_pages`. */
export function isPagesBuild(config: WranglerConfigLike, env: Record<string, string | undefined>): boolean {
  if (env.CF_PAGES || config.pages_build_output_dir) return true;
  if (env.WORKERS_CI || config.main || config.assets) return false;
  return true;
}

/** Resolves adapter-cloudflare's output layout from a wrangler config. */
export function cloudflareLayout(input: {
  root: string;
  /** `builder.getBuildDirectory('cloudflare')`. */
  buildDir: string;
  wrangler: WranglerConfigLike;
  env?: Record<string, string | undefined>;
}): CloudflareLayout {
  const { wrangler, root } = input;
  const pages = isPagesBuild(wrangler, input.env ?? process.env);
  const configDir = wrangler.configPath ? dirname(resolve(root, wrangler.configPath)) : root;
  let assetsDir = input.buildDir;
  let workerFile = join(assetsDir, '_worker.js');
  if (pages) {
    if (wrangler.pages_build_output_dir) {
      assetsDir = resolve(configDir, wrangler.pages_build_output_dir);
      workerFile = join(assetsDir, '_worker.js');
    }
  } else {
    if (wrangler.main) workerFile = resolve(configDir, wrangler.main);
    // wrangler resolves `main` but not `assets.directory` (relative to the config file).
    if (wrangler.assets?.directory) assetsDir = resolve(configDir, wrangler.assets.directory);
  }
  return {
    pages,
    assetsDir,
    workerFile,
    configPath: wrangler.configPath ? resolve(root, wrangler.configPath) : null,
  };
}

/**
 * Reads the wrangler config with wrangler's own reader (`unstable_readConfig`, which adapter-cloudflare uses):
 * wrangler is resolved from the project, else from adapter-cloudflare's dependencies.
 */
export async function readWranglerConfig(root: string, configFile?: string): Promise<WranglerConfigLike> {
  const fromProject = createRequire(join(root, 'package.json'));
  let entry: string | null = null;
  try {
    entry = fromProject.resolve('wrangler');
  } catch {
    try {
      const adapter = fromProject.resolve('@sveltejs/adapter-cloudflare');
      entry = createRequire(adapter).resolve('wrangler');
    } catch {
      entry = null;
    }
  }
  if (!entry)
    throw new Error(
      'hypdriv: wrangler is not installed; adapter-cloudflare needs it (`pnpm add -D wrangler`) and Hypdriv reads its config through it',
    );
  const mod = (await import(pathToFileURL(entry).href)) as {
    unstable_readConfig?: (args: { config?: string }) => WranglerConfigLike;
    default?: { unstable_readConfig?: (args: { config?: string }) => WranglerConfigLike };
  };
  const read = mod.unstable_readConfig ?? mod.default?.unstable_readConfig;
  if (typeof read !== 'function')
    throw new Error('hypdriv: this wrangler version has no unstable_readConfig');
  return read(configFile ? { config: configFile } : {});
}

/** The file the adapter's Worker is moved to when Hypdriv's shell takes its place. */
export const SVELTEKIT_WORKER = '_sveltekit_worker.js';

function importPath(fromDir: string, file: string): string {
  const rel = relative(fromDir, file).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Puts Hypdriv's Worker shell in front of the Worker adapter-cloudflare generated: the adapter's `_worker.js` moves to
 * `_sveltekit_worker.js` (kept out of the asset upload) and a new entry runs `createSvelteKitWorker()` around it,
 * exports Hypdriv's Durable Objects (and the application's own exports) and adds `scheduled`, `queue`, `email` and
 * `tail` handlers. Every request the Worker receives — including the ones SvelteKit answers before `handle`
 * (CSRF rejections, trailing-slash redirects, `/_app` 404s) — runs through the Drivetrain; the in-app `handle`
 * passes through inside it.
 */
export function wrapWorker(input: {
  layout: CloudflareLayout;
  /** `.svelte-kit/hypdriv`: where the config module is written. */
  buildDir: string;
  config: LoadedHypConfig;
  csp: SvelteKitCsp | null;
  manifest: HypManifest;
  /** A module whose named exports the Worker re-exports (Durable Objects, Workflows, entrypoints). */
  exports?: string | undefined;
  root: string;
}): { workerFile: string; appFile: string } {
  const { layout } = input;
  if (!existsSync(layout.workerFile))
    throw new Error(`hypdriv: adapter-cloudflare's Worker was not found at ${layout.workerFile}`);
  const dir = dirname(layout.workerFile);
  const appFile = join(dir, SVELTEKIT_WORKER);
  const generated = readFileSync(layout.workerFile, 'utf8');
  if (generated.includes('@hypdriv/sveltekit/worker'))
    throw new Error(
      `hypdriv: ${layout.workerFile} is already Hypdriv's Worker shell (the adapter did not run)`,
    );
  renameSync(layout.workerFile, appFile);

  // The Hypdriv config as a module the Worker bundle imports (relative paths keep the build relocatable).
  mkdirSync(input.buildDir, { recursive: true });
  const configFile = join(input.buildDir, 'worker-config.js');
  let configCode = configModuleCode(input.config);
  if (input.config.file)
    configCode = configCode.replace(
      JSON.stringify(input.config.file),
      JSON.stringify(importPath(input.buildDir, input.config.file)),
    );
  writeFileSync(configFile, configCode);

  const exportsFile = input.exports
    ? isAbsolute(input.exports)
      ? input.exports
      : resolve(input.root, input.exports)
    : null;
  if (exportsFile && !existsSync(exportsFile))
    throw new Error(`hypdriv: cloudflare.exports module not found: ${exportsFile}`);
  const lines = [
    '// Generated by @hypdriv/sveltekit: the SvelteKit Worker behind the Hypdriv Worker shell. Do not edit.',
    `import { createSvelteKitWorker } from '@hypdriv/sveltekit/worker';`,
    `import config from ${JSON.stringify(importPath(dir, configFile))};`,
    `import app from ${JSON.stringify(`./${SVELTEKIT_WORKER}`)};`,
    `export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/sveltekit/durable-objects';`,
    ...(exportsFile ? [`export * from ${JSON.stringify(importPath(dir, exportsFile))};`] : []),
    `const manifest = /* @__PURE__ */ JSON.parse(${JSON.stringify(JSON.stringify(input.manifest))});`,
    `const csp = ${JSON.stringify(input.csp ?? null)};`,
    'export default createSvelteKitWorker({ config, csp, manifest, app });',
    '',
  ];
  writeFileSync(layout.workerFile, lines.join('\n'));
  // A Worker file inside the assets directory would otherwise be uploaded as a public asset.
  const inAssets = relative(layout.assetsDir, appFile);
  if (!inAssets.startsWith('..') && !isAbsolute(inAssets))
    ensureAssetsIgnore(layout.assetsDir, [inAssets.split(sep).join('/')]);
  return { workerFile: layout.workerFile, appFile };
}

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultPurserVerifier, defaultSecretsScanner } from '@hypdriv/build';
import {
  createConsoleLogger,
  HYPDRIV_VERSION,
  type HypDrivConfig,
  type Logger,
  loadConfig,
  type ResolvedConfig,
} from '@hypdriv/core';
import { loadConfigFile, writeManifest } from '@hypdriv/core/node';
import { ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV, PROJECT_DIR_ENV, reviveConfig } from '../config/serialize';
import {
  type BuildManifestInput,
  buildManifest,
  type PurserVerifier,
  type SecretsScanner,
} from './build-manifest';
import { createNodeFs } from './fs';
import { renderReport } from './report';
import { mirrorAllScopedArtifacts } from './scoped-artifacts';
import type {
  AdapterNextConfig,
  ModifyConfigContext,
  NextAdapterLike,
  OnBuildCompleteContext,
} from './types';

export {
  appRouteAssets,
  assetFilePath,
  pagesRouteAssets,
  parseClientReferenceManifest,
  toPublicAssetPath,
} from './assets';
export type {
  BuildManifestInput,
  BuildManifestResult,
  PurserVerifier,
  PurserVerifierInput,
  PurserVerifierResult,
  SecretsScanner,
} from './build-manifest';
export { buildManifest } from './build-manifest';
export { classifyOutputs, staticFileRoutes } from './classify';
export { type AdapterFs, createNodeFs, rerootPaths } from './fs';
export * from './html';
export { renderReport } from './report';
export { mirrorAllScopedArtifacts, mirrorScopedArtifacts } from './scoped-artifacts';
export * from './types';

export interface CreateAdapterOptions {
  /** Module specifier or absolute path of the application's own adapter (Vercel, Bun, OpenNext...). */
  baseAdapter?: string | null;
  /** Explicit Hypdriv config (otherwise `.hypdriv/adapter-config.json`, then `hypdriv.config.*`). */
  config?: HypDrivConfig;
  log?: Logger;
  /**
   * Copy Next ≥ 16.4's scoped prerender artifacts (`server/route-cache`) to the classic layout. Default: on
   * when no base adapter is chained (OpenNext, Vercel's legacy builder, `next start`).
   */
  mirrorScopedArtifacts?: boolean;
  /** Hooks for tests. */
  purser?: PurserVerifier | null;
  secrets?: SecretsScanner | null;
}

async function importAdapter(spec: string): Promise<NextAdapterLike | null> {
  const url = spec.startsWith('file:')
    ? spec
    : spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)
      ? pathToFileURL(spec).href
      : spec;
  const mod = (await import(
    /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url
  )) as { default?: unknown } & Partial<NextAdapterLike>;
  const isAdapter = (value: unknown): value is NextAdapterLike =>
    !!value && typeof value === 'object' && typeof (value as NextAdapterLike).name === 'string';
  // ESM default, CJS interop (`default.default`), or a module whose named exports form the adapter.
  const first = mod.default;
  if (isAdapter(first)) return first;
  const nested = first && typeof first === 'object' ? (first as { default?: unknown }).default : undefined;
  if (isAdapter(nested)) return nested;
  return isAdapter(mod) ? mod : null;
}

async function resolveHypConfig(
  projectDir: string,
  explicit: HypDrivConfig | undefined,
  log: Logger,
): Promise<ResolvedConfig> {
  if (explicit) return loadConfig(explicit);
  const serialized = join(projectDir, ADAPTER_CONFIG_FILE);
  if (existsSync(serialized)) {
    try {
      return loadConfig(reviveConfig(readFileSync(serialized, 'utf8')));
    } catch (err) {
      log.warn('hypdriv: ignoring unreadable adapter config', { error: (err as Error).message });
    }
  }
  try {
    const { resolved } = await loadConfigFile(projectDir);
    return resolved;
  } catch (err) {
    log.warn('hypdriv: could not load hypdriv.config, using defaults', { error: (err as Error).message });
    return loadConfig({});
  }
}

/**
 * Creates the Hypdriv adapter. It delegates `modifyConfig` and `onBuildComplete` to the base adapter
 * (when configured) and then derives `.hypdriv/manifest.json` and `.hypdriv/report.md` (ADR 0002).
 */
export function createAdapter(options: CreateAdapterOptions = {}): NextAdapterLike {
  const log =
    options.log ?? createConsoleLogger({ format: 'pretty', fields: { component: 'hypdriv-adapter' } });
  const baseSpec =
    options.baseAdapter === undefined ? (process.env[BASE_ADAPTER_ENV] ?? null) : options.baseAdapter;
  let basePromise: Promise<NextAdapterLike | null> | null = null;
  const base = () => {
    if (!baseSpec) return Promise.resolve(null);
    basePromise ??= importAdapter(baseSpec).catch((err: Error) => {
      log.error(`hypdriv: could not load base adapter "${baseSpec}": ${err.message}`);
      throw err;
    });
    return basePromise;
  };

  return {
    name: 'hypdriv',
    async modifyConfig(config: AdapterNextConfig, ctx: ModifyConfigContext) {
      const b = await base();
      const next = b?.modifyConfig ? await b.modifyConfig(config, ctx) : config;
      process.env[PROJECT_DIR_ENV] = ctx.projectDir;
      return next;
    },
    async onBuildComplete(ctx: OnBuildCompleteContext) {
      const b = await base();
      // Without a platform adapter consuming the outputs, restore the classic prerender layout that
      // OpenNext and Vercel's legacy builder read (see scoped-artifacts.ts).
      if (options.mirrorScopedArtifacts ?? !b) {
        const { copied } = mirrorAllScopedArtifacts(ctx.distDir);
        if (copied)
          log.info(
            `hypdriv: restored ${copied} prerendered file(s) to the classic .next/server layout for deployment tooling`,
          );
      }
      const config = await resolveHypConfig(ctx.projectDir, options.config, log);
      const purser = options.purser === null ? null : (options.purser ?? (await defaultPurserVerifier()));
      const secrets = options.secrets === null ? null : (options.secrets ?? (await defaultSecretsScanner()));
      const input: BuildManifestInput = {
        context: ctx,
        config,
        fs: createNodeFs(),
        hypdrivVersion: HYPDRIV_VERSION,
        log,
        ...(purser ? { purser } : {}),
        ...(secrets ? { secrets } : {}),
      };
      const { manifest, failures } = await buildManifest(input);
      const { json, module } = await writeManifest(ctx.projectDir, manifest);
      createNodeFs().writeText(join(ctx.projectDir, '.hypdriv', 'report.md'), renderReport(manifest));
      for (const w of manifest.warnings) log.warn(`hypdriv: ${w}`);
      log.info(`hypdriv: manifest written (${manifest.routes.length} routes) → ${json}`);
      if (failures.length) {
        const message = `hypdriv: build failed\n${failures.map((f) => `  - ${f}`).join('\n')}`;
        log.error(message);
        throw new Error(message);
      }
      // Ship the manifest with every server function so `proxy.ts` and server helpers can read it at run
      // time on platforms that package functions from the adapter outputs (Vercel's adapter) or from
      // Next's file traces (Vercel's legacy builder, standalone output).
      const shipped = [json, module];
      if (b?.onBuildComplete) {
        await b.onBuildComplete(withExtraAssets(ctx, shipped));
      } else {
        const traced = addToServerTraces(ctx.distDir, shipped);
        if (traced) log.debug?.(`hypdriv: added the manifest to ${traced} server trace file(s)`);
      }
    },
  };
}

/** Returns a copy of the build context whose server outputs also carry `files` as traced assets. */
export function withExtraAssets(ctx: OnBuildCompleteContext, files: string[]): OnBuildCompleteContext {
  const root = ctx.repoRoot ?? ctx.projectDir;
  const extra = Object.fromEntries(files.map((file) => [relative(root, file).split('\\').join('/'), file]));
  const add = <T extends { assets: Record<string, string> }>(output: T): T => ({
    ...output,
    assets: { ...output.assets, ...extra },
  });
  const outputs = ctx.outputs;
  return {
    ...ctx,
    outputs: {
      ...outputs,
      appPages: outputs.appPages.map(add),
      appRoutes: outputs.appRoutes.map(add),
      pages: outputs.pages.map(add),
      pagesApi: outputs.pagesApi.map(add),
      ...(outputs.middleware ? { middleware: add(outputs.middleware) } : {}),
    },
  };
}

/**
 * Appends files to the `.nft.json` traces of the server entry points (`middleware.js` / proxy and the
 * route modules), which is how Next's standalone output and Vercel's legacy builder decide what to
 * package. Idempotent; returns the number of trace files changed.
 */
export function addToServerTraces(distDir: string, files: string[]): number {
  const serverDir = join(distDir, 'server');
  if (!existsSync(serverDir)) return 0;
  const fsx = createNodeFs();
  const traces = fsx
    .listFiles(serverDir)
    .filter((f) => f.endsWith('.js.nft.json') && !f.includes(`${join(serverDir, 'chunks')}`));
  let changed = 0;
  for (const trace of traces) {
    try {
      const data = JSON.parse(readFileSync(trace, 'utf8')) as { version?: number; files?: string[] };
      const list = Array.isArray(data.files) ? data.files : [];
      const dir = dirname(trace);
      let touched = false;
      for (const file of files) {
        const rel = relative(dir, file).split('\\').join('/');
        if (!list.includes(rel)) {
          list.push(rel);
          touched = true;
        }
      }
      if (touched) {
        fsx.writeText(trace, JSON.stringify({ ...data, files: list }));
        changed++;
      }
    } catch {
      // unreadable trace: leave it alone
    }
  }
  return changed;
}

const adapter: NextAdapterLike = createAdapter();
export default adapter;

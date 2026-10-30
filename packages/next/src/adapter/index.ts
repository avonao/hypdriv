import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HYPDRIV_VERSION, type HypDrivConfig, type Logger, type ResolvedConfig, createConsoleLogger, loadConfig } from '@hypdriv/core';
import { loadConfigFile, writeManifest } from '@hypdriv/core/node';
import { ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV, PROJECT_DIR_ENV, reviveConfig } from '../config/serialize';
import { type BuildManifestInput, type PurserVerifier, type SecretsScanner, buildManifest } from './build-manifest';
import { createNodeFs } from './fs';
import { renderReport } from './report';
import type { AdapterNextConfig, ModifyConfigContext, NextAdapterLike, OnBuildCompleteContext } from './types';

export * from './types';
export { buildManifest } from './build-manifest';
export type { BuildManifestInput, BuildManifestResult, PurserVerifier, SecretsScanner } from './build-manifest';
export { createNodeFs, rerootPaths, type AdapterFs } from './fs';
export { classifyOutputs, staticFileRoutes } from './classify';
export { renderReport } from './report';
export * from './html';
export { appRouteAssets, pagesRouteAssets, parseClientReferenceManifest, toPublicAssetPath, assetFilePath } from './assets';

export interface CreateAdapterOptions {
  /** Module specifier or absolute path of the application's own adapter (Vercel, Bun, OpenNext...). */
  baseAdapter?: string | null;
  /** Explicit HypDriv config (otherwise `.hypdriv/adapter-config.json`, then `hypdriv.config.*`). */
  config?: HypDrivConfig;
  log?: Logger;
  /** Hooks for tests. */
  purser?: PurserVerifier | null;
  secrets?: SecretsScanner | null;
}

async function importAdapter(spec: string): Promise<NextAdapterLike | null> {
  const url = spec.startsWith('file:') ? spec : spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) ? pathToFileURL(spec).href : spec;
  const mod = (await import(url)) as { default?: NextAdapterLike | { default?: NextAdapterLike } } & Partial<NextAdapterLike>;
  const candidate = (mod.default && 'default' in mod.default ? mod.default.default : mod.default) ?? (mod.name ? (mod as NextAdapterLike) : null);
  return candidate ?? null;
}

async function resolveHypConfig(projectDir: string, explicit: HypDrivConfig | undefined, log: Logger): Promise<ResolvedConfig> {
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

async function defaultPurserVerifier(): Promise<PurserVerifier | null> {
  try {
    const mod = (await import('@hypdriv/purser/node')) as {
      verifyBuild?: (input: { projectDir: string; config: NonNullable<ResolvedConfig['purser']>; prerenderedHtml: Record<string, string>; log?: Logger }) => Promise<{ manifest: import('@hypdriv/core').PurserManifest | null; ok: boolean; warnings: string[] }>;
      detectPurser?: (projectDir: string) => { installed: boolean };
    };
    if (!mod.verifyBuild || !mod.detectPurser) return null;
    return async ({ html, config, projectDir, log }) => {
      if (!config.purser) return { manifest: null, ok: true, warnings: [] };
      const detected = mod.detectPurser!(projectDir);
      if (!detected.installed) {
        if (config.purser.enabled === true) return { manifest: null, ok: false, warnings: ['Purser is enabled but @avonao/purser is not installed.'] };
        return { manifest: null, ok: true, warnings: [] };
      }
      return mod.verifyBuild!({ projectDir, config: config.purser, prerenderedHtml: html, log });
    };
  } catch {
    return null;
  }
}

async function defaultSecretsScanner(): Promise<SecretsScanner | null> {
  try {
    const mod = (await import('@hypdriv/security/node')) as {
      scanSecrets?: (options: {
        dirs: string[];
        patterns: Array<{ id: string; pattern: RegExp; severity: 'error' | 'warn' }>;
        env: Record<string, string | undefined>;
        publicPrefixes: string[];
        envAllowlist: string[];
        minValueLength: number;
      }) => Promise<Array<{ id: string; file: string; line: number; severity: 'error' | 'warn'; snippet: string }>>;
    };
    if (!mod.scanSecrets) return null;
    return async ({ dirs, config }) => {
      const scan = config.security.secretsScan;
      if (!scan) return { findings: [], ok: true };
      const findings = await mod.scanSecrets!({
        dirs,
        patterns: scan.patterns,
        env: process.env,
        publicPrefixes: scan.publicPrefixes,
        envAllowlist: scan.envAllowlist,
        minValueLength: scan.minValueLength,
      });
      return { findings, ok: !findings.some((f) => f.severity === 'error') };
    };
  } catch {
    return null;
  }
}

/**
 * Creates the HypDriv adapter. It delegates `modifyConfig` and `onBuildComplete` to the base adapter
 * (when configured) and then derives `.hypdriv/manifest.json` and `.hypdriv/report.md` (ADR 0002).
 */
export function createAdapter(options: CreateAdapterOptions = {}): NextAdapterLike {
  const log = options.log ?? createConsoleLogger({ format: 'pretty', fields: { component: 'hypdriv-adapter' } });
  const baseSpec = options.baseAdapter === undefined ? (process.env[BASE_ADAPTER_ENV] ?? null) : options.baseAdapter;
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
      if (b?.onBuildComplete) await b.onBuildComplete(ctx);
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
      const { json } = await writeManifest(ctx.projectDir, manifest);
      createNodeFs().writeText(join(ctx.projectDir, '.hypdriv', 'report.md'), renderReport(manifest));
      for (const w of manifest.warnings) log.warn(`hypdriv: ${w}`);
      log.info(`hypdriv: manifest written (${manifest.routes.length} routes) → ${json}`);
      if (failures.length) {
        const message = `hypdriv: build failed\n${failures.map((f) => `  - ${f}`).join('\n')}`;
        log.error(message);
        throw new Error(message);
      }
    },
  };
}

const adapter: NextAdapterLike = createAdapter();
export default adapter;

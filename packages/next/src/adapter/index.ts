import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HYPDRIV_VERSION, type HypDrivConfig, type Logger, type PurserManifest, type ResolvedConfig, createConsoleLogger, loadConfig } from '@hypdriv/core';
import { loadConfigFile, writeManifest } from '@hypdriv/core/node';
import { ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV, PROJECT_DIR_ENV, reviveConfig } from '../config/serialize';
import { type BuildManifestInput, type PurserVerifier, type SecretsScanner, buildManifest } from './build-manifest';
import { createNodeFs } from './fs';
import { renderReport } from './report';
import type { AdapterNextConfig, ModifyConfigContext, NextAdapterLike, OnBuildCompleteContext } from './types';

export * from './types';
export { buildManifest } from './build-manifest';
export type { BuildManifestInput, BuildManifestResult, PurserVerifier, PurserVerifierInput, PurserVerifierResult, SecretsScanner } from './build-manifest';
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
  const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as { default?: unknown } & Partial<NextAdapterLike>;
  const isAdapter = (value: unknown): value is NextAdapterLike => !!value && typeof value === 'object' && typeof (value as NextAdapterLike).name === 'string';
  // ESM default, CJS interop (`default.default`), or a module whose named exports form the adapter.
  const first = mod.default;
  if (isAdapter(first)) return first;
  const nested = first && typeof first === 'object' ? (first as { default?: unknown }).default : undefined;
  if (isAdapter(nested)) return nested;
  return isAdapter(mod) ? mod : null;
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

interface PurserNodeModule {
  verifyBuild: (input: {
    projectDir: string;
    config: NonNullable<ResolvedConfig['purser']>;
    prerenderedHtml: Record<string, string> | (() => Promise<Record<string, string>>);
  }) => Promise<{ ok: boolean; manifest: PurserManifest; errors: string[]; warnings: string[]; skipped: boolean }>;
  detectPurser: (projectDir: string) => { installed: boolean; message?: string };
  collectPrerenderedHtml: (distDir: string, options?: { includeRsc?: boolean; log?: Logger }) => Promise<Record<string, string>>;
}

interface PurserRuntimeModule {
  isPurserStylesheet: (css: string, layers?: { tokens: string; globals: string; atoms: string }) => boolean;
}

/**
 * Verifies the Purser stylesheet against every prerendered document and RSC payload (the unstyled-atom
 * guard), locates the CSS chunk Next.js emitted for it and returns the manifest section.
 */
async function defaultPurserVerifier(): Promise<PurserVerifier | null> {
  let node: PurserNodeModule;
  let runtime: PurserRuntimeModule;
  try {
    node = (await import('@hypdriv/purser/node')) as unknown as PurserNodeModule;
    runtime = (await import('@hypdriv/purser')) as unknown as PurserRuntimeModule;
  } catch {
    return null;
  }
  if (typeof node.verifyBuild !== 'function' || typeof node.detectPurser !== 'function') return null;
  return async ({ html, config, projectDir, distDir, cssAssets, readAsset, log }) => {
    const purser = config.purser;
    if (!purser || purser.enabled === false) return { manifest: null, ok: true, warnings: [] };
    const detected = node.detectPurser(projectDir);
    if (!detected.installed) {
      if (purser.enabled === true) return { manifest: null, ok: false, warnings: [], errors: [detected.message ?? 'Purser is enabled but @avonao/purser is not installed.'] };
      return { manifest: null, ok: true, warnings: [] };
    }
    const prerenderedHtml = async (): Promise<Record<string, string>> => {
      if (typeof node.collectPrerenderedHtml !== 'function') return html;
      const collected = await node.collectPrerenderedHtml(distDir, { includeRsc: true, log });
      return Object.keys(collected).length ? collected : html;
    };
    const result = await node.verifyBuild({ projectDir, config: purser, prerenderedHtml });
    const manifest: PurserManifest = { ...result.manifest };
    if (typeof runtime.isPurserStylesheet === 'function') {
      const asset = cssAssets.find((href) => {
        const css = readAsset(href);
        return css !== null && runtime.isPurserStylesheet(css, purser.layers);
      });
      if (asset) manifest.asset = asset;
    }
    return { manifest, ok: result.ok, warnings: result.warnings, errors: result.ok ? [] : result.errors };
  };
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

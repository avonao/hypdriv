import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HypDrivError,
  type HypDrivConfig,
  type Logger,
  type ResolvedConfig,
  createConsoleLogger,
  loadConfig,
} from '@hypdriv/core';
import { findConfigFile, loadConfigFile } from '@hypdriv/core/node';
import type { NextConfig } from 'next';
import { ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV, serializeConfig } from './serialize';

export { serializeConfig, reviveConfig, ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV } from './serialize';

export const PHASE = {
  developmentServer: 'phase-development-server',
  productionBuild: 'phase-production-build',
  productionServer: 'phase-production-server',
  export: 'phase-export',
  test: 'phase-test',
  info: 'phase-info',
} as const;

type NextConfigFn = (phase: string, ctx: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>;

export interface PurserBridgeLike {
  build(): Promise<PurserBuildResultLike>;
  watch(onResult: (result: PurserBuildResultLike) => void): Promise<{ close(): void }>;
  writeDevDiagnostics(result: PurserBuildResultLike): Promise<void>;
  formatDiagnostics?(result: PurserBuildResultLike): string;
  outFile: string | null;
}

export interface PurserBuildResultLike {
  css: string | null;
  diagnostics: Array<{ severity: 'error' | 'warning'; message: string; file?: string; line?: number; column?: number }>;
  stats: unknown;
  written: boolean;
  outFile: string | null;
}

export interface WithHypDrivOptions {
  /** Inline HypDriv config; takes precedence over `hypdriv.config.*`. */
  config?: HypDrivConfig;
  /** Explicit config file path, or `false` to skip file discovery. */
  configFile?: string | false;
  /** The application's own adapter (path or module specifier). `null` disables chaining; default: existing `adapterPath` / `NEXT_ADAPTER_PATH`. */
  adapter?: string | null;
  /** Override the HypDriv adapter module path (default: resolved from `@hypdriv/next/adapter`). */
  adapterPath?: string;
  /** Run the Purser bridge (default: when configured/detected). */
  purser?: boolean;
  /** Apply HypDriv's safe Next.js defaults (default true). */
  safeDefaults?: boolean;
  projectDir?: string;
  log?: Logger;
  /** Test seam: supplies the Purser bridge instead of loading `@hypdriv/purser/node`. */
  purserBridge?: (projectDir: string, config: ResolvedConfig) => Promise<PurserBridgeLike | null>;
  /** Test seam: deployment id resolver. */
  deploymentId?: () => string | null;
}

const WATCHERS = Symbol.for('hypdriv.purser.watchers');
type WatcherRegistry = Map<string, { close(): void }>;

function watcherRegistry(): WatcherRegistry {
  const g = globalThis as typeof globalThis & { [WATCHERS]?: WatcherRegistry };
  g[WATCHERS] ??= new Map();
  return g[WATCHERS];
}

/** Resolves the file path of the HypDriv adapter module for `adapterPath`. */
export function resolveAdapterPath(): string {
  const url = import.meta.resolve('@hypdriv/next/adapter');
  return url.startsWith('file:') ? fileURLToPath(url) : url;
}

/** Resolves the file path of the image loader module for `images.loaderFile`. */
export function resolveImageLoaderPath(): string | null {
  try {
    const url = import.meta.resolve('@hypdriv/image/loader');
    return url.startsWith('file:') ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

/** Deployment id for skew protection: an explicit env, a CI commit SHA, or the git HEAD; null when unknown. */
export function defaultDeploymentId(projectDir: string): string | null {
  const env = process.env;
  const fromEnv =
    env.HYPDRIV_DEPLOYMENT_ID ??
    env.WORKERS_CI_COMMIT_SHA ??
    env.CF_PAGES_COMMIT_SHA ??
    env.GITHUB_SHA ??
    env.VERCEL_GIT_COMMIT_SHA ??
    env.CI_COMMIT_SHA ??
    env.COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function resolveHypDrivConfig(projectDir: string, options: WithHypDrivOptions): Promise<{ input: HypDrivConfig; resolved: ResolvedConfig; file: string | null }> {
  if (options.config) return { input: options.config, resolved: loadConfig(options.config), file: null };
  if (options.configFile === false) return { input: {}, resolved: loadConfig({}), file: null };
  if (typeof options.configFile === 'string') {
    const file = isAbsolute(options.configFile) ? options.configFile : join(projectDir, options.configFile);
    if (!existsSync(file)) throw new HypDrivError('E_CONFIG', `hypdriv: config file not found: ${file}`);
    const mod = (await import(`${new URL(`file://${file}`).href}`)) as { default?: HypDrivConfig };
    const input = mod.default ?? {};
    return { input, resolved: loadConfig(input), file };
  }
  const loaded = await loadConfigFile(projectDir);
  return { input: loaded.config, resolved: loaded.resolved, file: loaded.file };
}

async function defaultPurserBridge(projectDir: string, config: ResolvedConfig, log: Logger): Promise<PurserBridgeLike | null> {
  if (!config.purser) return null;
  try {
    const mod = (await import('@hypdriv/purser/node')) as {
      detectPurser: (dir: string) => { installed: boolean; tokensFile: string | null; typescriptCompatible: boolean; typescriptVersion: string | null };
      createPurserBridge: (options: { projectDir: string; config: NonNullable<ResolvedConfig['purser']>; log?: Logger }) => Promise<PurserBridgeLike>;
    };
    const detected = mod.detectPurser(projectDir);
    const wanted = config.purser.enabled === true || (config.purser.enabled === 'auto' && detected.installed && (config.purser.tokens !== null || detected.tokensFile !== null));
    if (!wanted) return null;
    if (!detected.installed) throw new HypDrivError('E_UNSUPPORTED', 'hypdriv: purser is enabled but @avonao/purser is not installed (pnpm add @avonao/purser)');
    if (!detected.typescriptCompatible) {
      log.warn(`hypdriv: Purser needs TypeScript's programmatic API (found ${detected.typescriptVersion ?? 'unknown'}); install typescript@6 or the @typescript/typescript6 alias for the build.`);
    }
    return mod.createPurserBridge({ projectDir, config: config.purser, log });
  } catch (err) {
    if (err instanceof HypDrivError) throw err;
    log.warn(`hypdriv: Purser bridge unavailable (${(err as Error).message})`);
    return null;
  }
}

async function runPurser(phase: string, projectDir: string, config: ResolvedConfig, options: WithHypDrivOptions, log: Logger): Promise<void> {
  if (options.purser === false) return;
  const factory = options.purserBridge ?? ((dir, cfg) => defaultPurserBridge(dir, cfg, log));
  const bridge = await factory(projectDir, config);
  if (!bridge) return;
  const format = (r: PurserBuildResultLike) => bridge.formatDiagnostics?.(r) ?? r.diagnostics.map((d) => `${d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ''}: ` : ''}${d.severity}: ${d.message}`).join('\n');
  if (phase === PHASE.productionBuild || phase === PHASE.export) {
    const result = await bridge.build();
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    for (const d of result.diagnostics) (d.severity === 'error' ? log.error : log.warn).call(log, `purser: ${d.message}`, { file: d.file, line: d.line });
    if (errors.length) throw new HypDrivError('E_CONFIG', `hypdriv: Purser build failed\n${format(result)}`);
    log.info(`hypdriv: Purser stylesheet ${result.written ? 'written' : 'up to date'} (${result.outFile ?? bridge.outFile ?? 'memory'})`);
    return;
  }
  if (phase === PHASE.developmentServer) {
    const registry = watcherRegistry();
    if (registry.has(projectDir)) return;
    const handle = await bridge.watch((result) => {
      void bridge.writeDevDiagnostics(result);
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      if (errors.length) log.error(`purser: ${errors.length} error(s)\n${format(result)}`);
      else if (result.written) log.info('purser: stylesheet updated');
    });
    registry.set(projectDir, handle);
    process.once('exit', () => handle.close());
  }
}

function applySafeDefaults(out: NextConfig, config: ResolvedConfig, phase: string, projectDir: string, options: WithHypDrivOptions, log: Logger): void {
  out.poweredByHeader = false;
  out.reactStrictMode ??= true;
  if (config.security.sri) {
    out.experimental = { ...(out.experimental ?? {}), sri: { algorithm: config.security.sri.algorithm } } as NextConfig['experimental'];
  }
  if (config.performance.skewProtection && !out.deploymentId) {
    const id = config.performance.skewProtection.deploymentId ?? (options.deploymentId ?? (() => defaultDeploymentId(projectDir)))();
    if (id) out.deploymentId = id;
    else if (phase === PHASE.productionBuild) log.warn('hypdriv: skew protection is on but no deployment id could be derived (set HYPDRIV_DEPLOYMENT_ID or build from a git checkout).');
  }
  if (config.images.loader === 'cloudflare' && !out.images?.loaderFile && out.images?.loader !== 'custom' && !out.images?.unoptimized) {
    const loader = resolveImageLoaderPath();
    if (loader) out.images = { ...(out.images ?? {}), loader: 'custom', loaderFile: loader };
  }
}

/**
 * Wraps a Next.js config with HypDriv (ADR 0001/0002). Returns an async config function, so it can run
 * the Purser build before the bundler starts and install the adapter chain.
 */
export function withHypDriv(nextConfig: NextConfig | NextConfigFn = {}, options: WithHypDrivOptions = {}): NextConfigFn {
  return async (phase, ctx) => {
    const log = options.log ?? createConsoleLogger({ format: 'pretty', fields: { component: 'hypdriv' } });
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const base: NextConfig = typeof nextConfig === 'function' ? await nextConfig(phase, ctx) : { ...nextConfig };
    const { input, resolved, file } = await resolveHypDrivConfig(projectDir, options);

    // Share the configuration with the adapter process (functions are dropped, RegExps preserved).
    try {
      const target = join(projectDir, ADAPTER_CONFIG_FILE);
      mkdirSync(join(projectDir, '.hypdriv'), { recursive: true });
      writeFileSync(target, serializeConfig(input));
    } catch (err) {
      log.warn(`hypdriv: could not write ${ADAPTER_CONFIG_FILE}: ${(err as Error).message}`);
    }

    if (phase === PHASE.productionBuild || phase === PHASE.developmentServer || phase === PHASE.export) {
      await runPurser(phase, projectDir, resolved, options, log);
    }

    const out: NextConfig = { ...base };
    if (options.safeDefaults !== false) applySafeDefaults(out, resolved, phase, projectDir, options, log);

    // Adapter chain.
    const baseAdapter = options.adapter === null ? null : (options.adapter ?? base.adapterPath ?? process.env.NEXT_ADAPTER_PATH ?? null);
    if (baseAdapter) process.env[BASE_ADAPTER_ENV] = isAbsolute(baseAdapter) || baseAdapter.startsWith('.') ? resolve(projectDir, baseAdapter) : baseAdapter;
    else delete process.env[BASE_ADAPTER_ENV];
    out.adapterPath = options.adapterPath ?? resolveAdapterPath();

    if (phase === PHASE.productionBuild) {
      log.info(`hypdriv: config ${file ? `from ${file}` : options.config ? 'inline' : 'defaults'}; adapter chain → ${baseAdapter ?? 'none'}`);
    }
    return out;
  };
}

/** Locates `hypdriv.config.*` for tooling. */
export function hypdrivConfigFile(projectDir: string): string | null {
  return findConfigFile(projectDir);
}

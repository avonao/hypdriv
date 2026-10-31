import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConsoleLogger,
  type DeployTarget,
  type HypDrivConfig,
  HypDrivError,
  type Logger,
  loadConfig,
  type ResolvedConfig,
} from '@hypdriv/core';
import { findConfigFile, installedVersion, loadConfigFile } from '@hypdriv/core/node';
import type { NextConfig } from 'next';
import { ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV, serializeConfig } from './serialize';

export { ADAPTER_CONFIG_FILE, BASE_ADAPTER_ENV, reviveConfig, serializeConfig } from './serialize';

export const PHASE = {
  developmentServer: 'phase-development-server',
  productionBuild: 'phase-production-build',
  productionServer: 'phase-production-server',
  export: 'phase-export',
  test: 'phase-test',
  info: 'phase-info',
} as const;

type NextConfigFn = (phase: string, ctx: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>;

/** The subset of `@hypdriv/purser/node`'s `PurserBridge` that `withHypDriv` uses. */
export interface PurserBridgeLike {
  build(): Promise<PurserBuildResultLike>;
  /** Starts (or joins) the per-process watcher; `devDiagnostics` writes `.hypdriv/dev/purser.json` for the HUD. */
  watch(
    onResult?: (result: PurserBuildResultLike) => void,
    options?: { devDiagnostics?: boolean },
  ): Promise<{ close(): void }>;
  formatDiagnostics?(result: PurserBuildResultLike): string;
  formatSummary?(result: PurserBuildResultLike): string;
  hasErrors?(result: PurserBuildResultLike): boolean;
  outFile: string | null;
}

export interface PurserBuildResultLike {
  css: string | null;
  diagnostics: Array<{
    severity: 'error' | 'warning';
    message: string;
    file?: string;
    line?: number;
    column?: number;
  }>;
  stats: unknown;
  written: boolean;
  outFile: string | null;
}

export interface WithHypDrivOptions {
  /** Inline Hypdriv config; takes precedence over `hypdriv.config.*`. */
  config?: HypDrivConfig;
  /** Explicit config file path, or `false` to skip file discovery. */
  configFile?: string | false;
  /** The application's own adapter (path or module specifier). `null` disables chaining; default: existing `adapterPath` / `NEXT_ADAPTER_PATH`. */
  adapter?: string | null;
  /** Override the Hypdriv adapter module path (default: resolved from `@hypdriv/next/adapter`). */
  adapterPath?: string;
  /** Run the Purser bridge (default: when configured/detected). */
  purser?: boolean;
  /** Apply Hypdriv's safe Next.js defaults (default true). */
  safeDefaults?: boolean;
  projectDir?: string;
  log?: Logger;
  /** Test seam: supplies the Purser bridge instead of loading `@hypdriv/purser/node`. */
  purserBridge?: (projectDir: string, config: ResolvedConfig) => Promise<PurserBridgeLike | null>;
  /** Deploy target override (default: `resolveBuildTarget`). */
  target?: DeployTarget;
  /** Test seam: deployment id resolver. */
  deploymentId?: () => string | null;
}

const WATCHERS = Symbol.for('hypdriv.next.purser-subscriptions');
type WatcherRegistry = Map<string, { close(): void }>;

function watcherRegistry(): WatcherRegistry {
  const g = globalThis as typeof globalThis & { [WATCHERS]?: WatcherRegistry };
  g[WATCHERS] ??= new Map();
  return g[WATCHERS];
}

/** Resolves the file path of the Hypdriv adapter module for `adapterPath`. */
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

/** Environment variable that carries one build's deployment id to every process of that build. */
export const BUILD_DEPLOYMENT_ID_ENV = '__HYPDRIV_BUILD_DEPLOYMENT_ID';

const DEPLOYMENT_ID_CHARS = /[^a-zA-Z0-9_-]+/g;

/** Next.js accepts letters, digits, `-` and `_` in `deploymentId`; Hypdriv caps the length at 64. */
export function sanitizeDeploymentId(id: string): string {
  return id
    .replace(DEPLOYMENT_ID_CHARS, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** The commit a build comes from: a CI commit SHA or the git HEAD (10 hex characters); null outside both. */
export function buildCommit(projectDir: string): string | null {
  const env = process.env;
  const fromEnv =
    env.WORKERS_CI_COMMIT_SHA ??
    env.CF_PAGES_COMMIT_SHA ??
    env.GITHUB_SHA ??
    env.VERCEL_GIT_COMMIT_SHA ??
    env.CI_COMMIT_SHA ??
    env.COMMIT_SHA;
  if (fromEnv) return sanitizeDeploymentId(fromEnv).slice(0, 10) || null;
  try {
    return (
      execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
        .slice(0, 10) || null
    );
  } catch {
    return null;
  }
}

export interface DeploymentIdOptions {
  now?: () => number;
  /** Four characters of randomness (base 36). */
  random?: () => string;
}

/**
 * Deployment id for skew protection (ADR 0016): `HYPDRIV_DEPLOYMENT_ID` verbatim when set, otherwise
 * `<commit>-<build stamp>`, unique per build. Every process of one `next build` (config is evaluated in
 * the main process and again in build workers) gets the same id through {@link BUILD_DEPLOYMENT_ID_ENV}.
 *
 * Uniqueness matters beyond skew protection: Next.js 16 sets a constant `BUILD_ID` whenever a deployment
 * id exists, and OpenNext keys its incremental, regional and tag caches by the deployment id. Two apps built
 * from one commit — or one commit built twice with different environment variables — must never share it,
 * or they read each other's cached pages (the Cache API is shared by every Worker on a zone).
 */
export function defaultDeploymentId(projectDir: string, options: DeploymentIdOptions = {}): string {
  const env = process.env;
  const explicit = env.HYPDRIV_DEPLOYMENT_ID?.trim();
  if (explicit) {
    const id = sanitizeDeploymentId(explicit);
    if (id) return id;
  }
  const scope = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 8);
  const memo = env[BUILD_DEPLOYMENT_ID_ENV];
  if (memo) {
    const sep = memo.indexOf(':');
    if (sep > 0 && memo.slice(0, sep) === scope && memo.length > sep + 1) return memo.slice(sep + 1);
  }
  const now = options.now ?? Date.now;
  const random =
    options.random ?? (() => randomBytes(4).readUInt32BE(0).toString(36).padStart(4, '0').slice(-4));
  const stamp = `${Math.floor(now() / 1000).toString(36)}${random()}`;
  const id = `${buildCommit(projectDir) ?? 'build'}-${stamp}`;
  env[BUILD_DEPLOYMENT_ID_ENV] = `${scope}:${id}`;
  return id;
}

async function resolveHypDrivConfig(
  projectDir: string,
  options: WithHypDrivOptions,
): Promise<{ input: HypDrivConfig; resolved: ResolvedConfig; file: string | null }> {
  if (options.config) return { input: options.config, resolved: loadConfig(options.config), file: null };
  if (options.configFile === false) return { input: {}, resolved: loadConfig({}), file: null };
  if (typeof options.configFile === 'string') {
    const file = isAbsolute(options.configFile) ? options.configFile : join(projectDir, options.configFile);
    if (!existsSync(file)) throw new HypDrivError('E_CONFIG', `hypdriv: config file not found: ${file}`);
    const loaded = await loadConfigFile(projectDir, file);
    return { input: loaded.config, resolved: loaded.resolved, file };
  }
  const loaded = await loadConfigFile(projectDir);
  return { input: loaded.config, resolved: loaded.resolved, file: loaded.file };
}

async function defaultPurserBridge(
  projectDir: string,
  config: ResolvedConfig,
  log: Logger,
): Promise<PurserBridgeLike | null> {
  const purser = config.purser;
  if (!purser || purser.enabled === false) return null;
  const explicit = purser.enabled === true;
  let mod: {
    detectPurser: (dir: string) => {
      installed: boolean;
      tokensFile: string | null;
      typescriptCompatible: boolean;
      typescriptVersion: string | null;
      message?: string;
    };
    createPurserBridge: (options: {
      projectDir: string;
      config: NonNullable<ResolvedConfig['purser']>;
      log?: Logger;
    }) => Promise<PurserBridgeLike>;
  };
  try {
    mod = (await import('@hypdriv/purser/node')) as unknown as typeof mod;
  } catch (err) {
    if (explicit)
      throw new HypDrivError(
        'E_UNSUPPORTED',
        `hypdriv: purser is enabled but @hypdriv/purser could not be loaded (${(err as Error).message})`,
      );
    return null;
  }
  const detected = mod.detectPurser(projectDir);
  const wanted = explicit || (detected.installed && (purser.tokens !== null || detected.tokensFile !== null));
  if (!wanted) return null;
  if (!detected.installed)
    throw new HypDrivError(
      'E_UNSUPPORTED',
      detected.message ??
        'hypdriv: purser is enabled but @avonao/purser is not installed (pnpm add @avonao/purser)',
    );
  try {
    return await mod.createPurserBridge({ projectDir, config: purser, log });
  } catch (err) {
    // Explicitly enabled: surface the problem (TypeScript 7 without the TS 6 alias, broken install). Auto: skip.
    if (explicit) throw err;
    log.warn(
      `hypdriv: Purser detected but the bridge is unavailable (${(err as Error).message}); skipping the CSS build.`,
    );
    return null;
  }
}

function formatPurserDiagnostics(bridge: PurserBridgeLike, result: PurserBuildResultLike): string {
  return (
    bridge.formatDiagnostics?.(result) ??
    result.diagnostics
      .map(
        (d) =>
          `${d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ''}: ` : ''}${d.severity}: ${d.message}`,
      )
      .join('\n')
  );
}

function purserHasErrors(bridge: PurserBridgeLike, result: PurserBuildResultLike): boolean {
  return bridge.hasErrors?.(result) ?? result.diagnostics.some((d) => d.severity === 'error');
}

async function runPurser(
  phase: string,
  projectDir: string,
  config: ResolvedConfig,
  options: WithHypDrivOptions,
  log: Logger,
): Promise<void> {
  if (options.purser === false) return;
  const factory = options.purserBridge ?? ((dir, cfg) => defaultPurserBridge(dir, cfg, log));
  if (phase === PHASE.productionBuild || phase === PHASE.export) {
    const bridge = await factory(projectDir, config);
    if (!bridge) return;
    const result = await bridge.build();
    if (purserHasErrors(bridge, result))
      throw new HypDrivError(
        'E_CONFIG',
        `hypdriv: Purser build failed\n${formatPurserDiagnostics(bridge, result)}`,
      );
    // The bridge logs warnings and the build summary through the logger it was created with.
    return;
  }
  if (phase === PHASE.developmentServer) {
    // next.config is evaluated more than once per dev process; subscribe exactly once per project.
    const registry = watcherRegistry();
    if (registry.has(projectDir)) return;
    const bridge = await factory(projectDir, config);
    if (!bridge) return;
    registry.set(projectDir, { close() {} });
    try {
      const handle = await bridge.watch(
        (result) => {
          if (purserHasErrors(bridge, result))
            log.error(`purser: build errors\n${formatPurserDiagnostics(bridge, result)}`);
          else if (result.written) log.info('purser: stylesheet updated');
        },
        { devDiagnostics: true },
      );
      registry.set(projectDir, handle);
      process.once('exit', () => handle.close());
    } catch (err) {
      registry.delete(projectDir);
      throw err;
    }
  }
}

/**
 * The deploy target for this build: `platform` from the Hypdriv config when set; otherwise Vercel when the
 * build runs on Vercel (`VERCEL=1`, `NEXT_EDGE_RUNTIME_PROVIDER=vercel`) or the project has a Vercel
 * config, Cloudflare when the project has a wrangler config or `@opennextjs/cloudflare`, else a Node host.
 */
export function resolveBuildTarget(
  projectDir: string,
  config: Pick<ResolvedConfig, 'platform'>,
  env: Record<string, string | undefined> = process.env,
): DeployTarget {
  if (config.platform !== 'auto') return config.platform;
  if (env.VERCEL === '1' || env.NEXT_EDGE_RUNTIME_PROVIDER === 'vercel') return 'vercel';
  const has = (name: string) => existsSync(join(projectDir, name));
  if (
    has('wrangler.jsonc') ||
    has('wrangler.json') ||
    has('wrangler.toml') ||
    has('cloudflare.config.ts') ||
    installedVersion(projectDir, '@opennextjs/cloudflare')
  )
    return 'cloudflare';
  if (has('vercel.json') || has('vercel.ts') || has('vercel.toml') || has('.vercel')) return 'vercel';
  return 'node';
}

function applySafeDefaults(
  out: NextConfig,
  config: ResolvedConfig,
  phase: string,
  projectDir: string,
  options: WithHypDrivOptions,
  log: Logger,
): void {
  const target = options.target ?? resolveBuildTarget(projectDir, config);
  out.poweredByHeader = false;
  out.reactStrictMode ??= true;
  if (config.security.sri) {
    out.experimental = {
      ...(out.experimental ?? {}),
      sri: { algorithm: config.security.sri.algorithm },
    } as NextConfig['experimental'];
  }
  // Vercel assigns the deployment id itself (skew protection via NEXT_DEPLOYMENT_ID / VERCEL_DEPLOYMENT_ID).
  if (config.performance.skewProtection && !out.deploymentId && target !== 'vercel') {
    const id =
      config.performance.skewProtection.deploymentId ??
      (options.deploymentId ?? (() => defaultDeploymentId(projectDir)))();
    if (id) out.deploymentId = id;
    else if (phase === PHASE.productionBuild)
      log.warn(
        'hypdriv: skew protection is on but no deployment id could be derived (set HYPDRIV_DEPLOYMENT_ID or build from a git checkout).',
      );
  }
  // `auto`: the Cloudflare loader only on Cloudflare; on Vercel a custom loader would bypass Vercel Image
  // Optimization, and on Node hosts Next's own optimizer is the right default.
  const imageLoader =
    config.images.loader === 'auto'
      ? target === 'cloudflare'
        ? 'cloudflare'
        : 'next'
      : config.images.loader;
  if (
    imageLoader === 'cloudflare' &&
    !out.images?.loaderFile &&
    out.images?.loader !== 'custom' &&
    !out.images?.unoptimized
  ) {
    const loader = resolveImageLoaderPath();
    if (loader) {
      // Next.js resolves `loaderFile` against the project directory, so it must be relative.
      const rel = relative(projectDir, loader).split('\\').join('/');
      out.images = {
        ...(out.images ?? {}),
        loader: 'custom',
        loaderFile: rel.startsWith('.') ? rel : `./${rel}`,
      };
      // Inlined by Next into server and client bundles; read by `@hypdriv/image/loader`.
      const format =
        config.images.formats.length === 1 && config.images.formats[0] !== 'auto'
          ? config.images.formats[0]
          : 'auto';
      const loaderConfig = {
        cdnCgi: config.images.cdnCgi,
        quality: config.images.quality,
        format,
        ...(out.basePath ? { basePath: out.basePath } : {}),
      };
      out.env = { ...(out.env ?? {}), HYPDRIV_IMAGES: JSON.stringify(loaderConfig) };
    }
  }
}

/**
 * On Vercel the CDN caches what the function returns and Routing Middleware cannot set caching headers, so
 * explicit edge-cache policies become `headers()` rules carrying `Vercel-CDN-Cache-Control` and
 * `Vercel-Cache-Tag` (`vercelCdnRouteHeaders`). Hypdriv's rules come first: the application's own rules for
 * the same header and path win.
 */
async function applyVercelCdnHeaders(
  out: NextConfig,
  config: ResolvedConfig,
  phase: string,
  log: Logger,
): Promise<void> {
  const { vercelCdnRouteHeaders } = await import('@hypdriv/vercel');
  const { rules, skipped } = vercelCdnRouteHeaders(config);
  if (rules.length) {
    const appHeaders = out.headers;
    out.headers = async () => [...rules, ...(appHeaders ? await appHeaders() : [])];
  }
  if (phase === PHASE.productionBuild) {
    if (rules.length) log.info(`hypdriv: ${rules.length} Vercel CDN header rule(s) from edge-cache policies`);
    for (const { policy, reason } of skipped) {
      // `respect-origin` is the normal case (the page's own Cache-Control drives the CDN, prerenders are
      // cached natively); any other reason means pages matched by the policy are not CDN-cached on Vercel.
      if (reason === 'respect-origin')
        log.info(
          `hypdriv: edge-cache policy "${policy}" follows the origin's Cache-Control on Vercel (respectOrigin); wrap its Route Handlers with withVercelCdn() to apply it there`,
        );
      else
        log.warn(
          `hypdriv: edge-cache policy "${policy}" has no Vercel route-header form (${reason}): pages it matches are not CDN-cached on Vercel; Route Handlers can apply it with withVercelCdn()`,
        );
    }
  }
}

/**
 * Wraps a Next.js config with Hypdriv (ADR 0001/0002). Returns an async config function, so it can run
 * the Purser build before the bundler starts and install the adapter chain.
 */
export function withHypDriv(
  nextConfig: NextConfig | NextConfigFn = {},
  options: WithHypDrivOptions = {},
): NextConfigFn {
  return async (phase, ctx) => {
    const log = options.log ?? createConsoleLogger({ format: 'pretty', fields: { component: 'hypdriv' } });
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const base: NextConfig =
      typeof nextConfig === 'function' ? await nextConfig(phase, ctx) : { ...nextConfig };
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
    const target = options.target ?? resolveBuildTarget(projectDir, resolved);
    if (target === 'vercel') await applyVercelCdnHeaders(out, resolved, phase, log);

    // Adapter chain.
    const baseAdapter =
      options.adapter === null
        ? null
        : (options.adapter ?? base.adapterPath ?? process.env.NEXT_ADAPTER_PATH ?? null);
    if (baseAdapter)
      process.env[BASE_ADAPTER_ENV] =
        isAbsolute(baseAdapter) || baseAdapter.startsWith('.')
          ? resolve(projectDir, baseAdapter)
          : baseAdapter;
    else delete process.env[BASE_ADAPTER_ENV];
    out.adapterPath = options.adapterPath ?? resolveAdapterPath();

    if (phase === PHASE.productionBuild) {
      log.info(
        `hypdriv: config ${file ? `from ${file}` : options.config ? 'inline' : 'defaults'}; adapter chain → ${baseAdapter ?? 'none'}`,
      );
    }
    return out;
  };
}

/** Locates `hypdriv.config.*` for tooling. */
export function hypdrivConfigFile(projectDir: string): string | null {
  return findConfigFile(projectDir);
}

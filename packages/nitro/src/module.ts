import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type { FrameworkName, HypDrivConfig, HypManifest, Logger, ManifestFramework } from '@hypdriv/core';
import {
  addVercelMiddleware,
  configModuleCode,
  type DiscoveredRoute,
  developmentManifest,
  type FinalizeResult,
  type LoadedHypConfig,
  loadHypConfig,
  manifestModuleCode,
  readViteManifest,
  VIRTUAL_CONFIG,
  VIRTUAL_MANIFEST,
  type ViteManifest,
} from '@hypdriv/vite';
import {
  cloudflareEntryCode,
  cloudflareExportsCode,
  durableObjectsEntry,
  type NitroMajor,
} from './build/cloudflare';
import {
  assertFinalized,
  completeNitroOutput,
  type FinalizeNitroInput,
  finalizeNitroManifest,
  type PrerenderedRoute,
  removeViteMetadata,
} from './build/finalize';
import {
  bundledModules,
  escapeRegExp,
  pushUnique,
  type RollupExternal,
  runtimePackages,
  withExternal,
} from './build/nitro-config';
import { packageDir, runtimeFile } from './build/paths';
import { discoverNitroRoutes, type NitroHandlerLike, type NitroRendererLike } from './build/routes';
import {
  isDevPreset,
  isPrerenderPreset,
  isStaticPreset,
  type NitroTarget,
  supportsWorkerEntry,
  targetOfPreset,
} from './build/targets';
import { type NitroRuntimeOptions, VIRTUAL_CLOUDFLARE_EXPORTS, VIRTUAL_OPTIONS } from './runtime/options';

/** Nitro 3's virtual module with the exports of the Cloudflare development Worker (Vite builder). */
const DEV_WORKER_EXPORTS = '#nitro/virtual/dev-worker-exports';

/** The parts of a Nitro instance (Nitro 2 or Nitro 3) the module uses. */
export interface NitroLike {
  meta?: { version?: string; majorVersion?: number };
  options: {
    preset?: string;
    dev?: boolean;
    rootDir: string;
    buildDir: string;
    baseURL?: string;
    output: { dir: string; serverDir: string; publicDir: string };
    virtual: Record<string, string | (() => string | Promise<string>)>;
    plugins: string[];
    entry?: string;
    handlers?: NitroHandlerLike[];
    renderer?: NitroRendererLike;
    alias?: Record<string, string>;
    /** Nitro 2. */
    externals?: false | { inline?: Array<string | RegExp>; [key: string]: unknown };
    rollupConfig?: { external?: RollupExternal; [key: string]: unknown };
    imports?: false | { exclude?: unknown; [key: string]: unknown };
    /** Nitro 3. */
    noExternals?: boolean | Array<string | RegExp>;
    builtinModules?: string[];
    builder?: string;
    routeRules?: Record<string, unknown>;
    /** consola's level (Nitro 2 and 3). */
    logLevel?: number;
    [key: string]: unknown;
  };
  hooks: { hook(name: string, listener: (...args: never[]) => unknown): unknown };
  logger: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  scannedHandlers?: NitroHandlerLike[];
  routing?: { routes?: { routes: NitroHandlerLike[] } };
  [key: string]: unknown;
}

/** A Nitro module (Nitro 2.9+ and Nitro 3 accept this shape in `modules`). */
export interface NitroModuleLike {
  name?: string;
  setup(nitro: NitroLike): void | Promise<void>;
}

/** What a framework integration's route discovery receives. */
export interface RouteDiscoveryContext {
  nitro: NitroLike;
  rootDir: string;
  major: NitroMajor;
}

/** Options of the `@hypdriv/nitro` module. */
export interface HypdrivNitroOptions {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /** The project root (default: Nitro's `rootDir`). */
  root?: string;
  /** Run the pipeline in the development server (default true). */
  dev?: boolean;
  /**
   * Hand the request's CSP nonce to the application (`event.context.hypdriv.nonce`, the `x-nonce` request header;
   * default true). The pipeline's HTML injection covers markup the application does not stamp itself.
   */
  nonce?: boolean;
  /**
   * Write the static header rules (security headers, the hash CSP of prerendered documents, Early Hints) into
   * Cloudflare's `_headers` / Vercel's Build Output `config.json` (default true).
   */
  staticHeaders?: boolean;
  vercel?: {
    /**
     * Run Hypdriv's Routing Middleware for prerendered pages, which Vercel's CDN serves without Nitro's function
     * (rate limiting, bot shield, maintenance, redirects, geo; default true).
     */
    middleware?: boolean;
  };
  cloudflare?: {
    /**
     * Build the `cloudflare-module` Worker with Hypdriv's entry: the Hypdriv Worker shell (`createWorker`) around
     * Nitro, with `scheduled` / `queue` / `email` dispatch and the Hypdriv Durable Objects exported (default true).
     */
    worker?: boolean;
    /**
     * A module whose named exports the Worker entry re-exports (your own Durable Objects, Workflows,
     * `WorkerEntrypoint`s), e.g. `'./server/worker-exports.ts'` (relative to the project root).
     */
    exports?: string;
  };
  /** Public path prefixes of immutable build assets, answered without the pipeline (default `['/assets/']`). */
  assetPrefixes?: string[];
  /**
   * Serve the files under `assetPrefixes` with `cache-control: public, max-age=31536000, immutable`, as a Nitro route
   * rule (Nitro writes it into `_headers` / the Vercel Build Output too). A prefix that already has a
   * `cache-control` rule keeps it. Default: on when `assetPrefixes` is given (the prefixes are then known to hold
   * content-hashed files), off for the `/assets/` guess; with plain Nitro use `publicAssets` + `maxAge`.
   */
  immutableAssets?: boolean;
  /** The framework that builds the app on top of Nitro (default: plain Nitro). */
  framework?: {
    name?: FrameworkName;
    version?: string;
    bundler?: string;
    bundlerVersion?: string;
    /** The label `createHandler` reports as `host` (default: the framework name). */
    host?: string;
  };
  /** The framework's pages, when Nitro does not know them (Analog's file router). */
  routes?: (context: RouteDiscoveryContext) => DiscoveredRoute[] | Promise<DiscoveredRoute[]>;
  /** Whether a Nitro handler route renders HTML documents (default: GET routes outside `/api/`). */
  isPage?: (route: string, handler: NitroHandlerLike) => boolean;
  /** Pages never navigated to directly (error documents). */
  internalPages?: string[];
  /** Per-page client assets on top of the shared entry assets of the Vite client build. */
  pageAssets?: FinalizeNitroInput['pageAssets'];
  /** The Vite client build's manifest (default: `<publicDir>/.vite/manifest.json`). */
  clientManifest?: (context: {
    publicDir: string;
    rootDir: string;
  }) => ViteManifest | null | Promise<ViteManifest | null>;
}

/**
 * Hypdriv's logger on Nitro's. Nitro's consola levels: 0 prints errors only, 1 warnings, 3 info. A host that builds
 * Nitro quietly (Analog uses level 0) must not hide Hypdriv's build warnings, so those go to the console then.
 */
function toHypLogger(nitro: NitroLike): Logger {
  const { logger } = nitro;
  const level = typeof nitro.options.logLevel === 'number' ? nitro.options.logLevel : 3;
  const fmt = (message: string, fields?: Record<string, unknown>) =>
    fields && Object.keys(fields).length ? `${message} ${JSON.stringify(fields)}` : message;
  const out: Logger = {
    level: 'info',
    debug: (m, f) => logger.debug(fmt(m, f)),
    info: (m, f) => logger.info(fmt(m, f)),
    warn: (m, f) => (level < 1 ? console.warn(fmt(m, f)) : logger.warn(fmt(m, f))),
    error: (m, f) => logger.error(fmt(m, f)),
    child: () => out,
  };
  return out;
}

/** The Nitro major of an instance. */
export function nitroMajor(nitro: NitroLike): NitroMajor {
  const major = nitro.meta?.majorVersion;
  if (major === 2 || major === 3) return major;
  return 'routing' in nitro ? 3 : 2;
}

function packageVersion(rootDir: string, name: string): string | undefined {
  try {
    const require = createRequire(join(rootDir, 'package.json'));
    return (require(`${name}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function viteVersion(rootDir: string): string | undefined {
  return packageVersion(rootDir, 'vite');
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Route rules that cache the content-hashed build assets for a year. Rules are relative to Nitro's `baseURL`; a prefix
 * that already carries a `cache-control` rule is left to the application.
 */
function immutableAssetRules(nitro: NitroLike, prefixes: string[]): void {
  const base = (nitro.options.baseURL || '/').replace(/\/+$/, '');
  nitro.options.routeRules ||= {};
  const rules = nitro.options.routeRules as Record<string, { headers?: Record<string, string> }>;
  for (const prefix of prefixes) {
    const dir = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const relative = base && dir.startsWith(`${base}/`) ? dir.slice(base.length) : dir;
    const glob = `${relative}**`;
    const existing = rules[glob];
    if (
      existing?.headers &&
      Object.keys(existing.headers).some((name) => name.toLowerCase() === 'cache-control')
    )
      continue;
    rules[glob] = { ...existing, headers: { ...existing?.headers, 'cache-control': IMMUTABLE } };
  }
}

async function setupNitro(nitro: NitroLike, options: HypdrivNitroOptions): Promise<void> {
  const major = nitroMajor(nitro);
  const preset = nitro.options.preset;
  const dev = !!nitro.options.dev || isDevPreset(preset);
  const prerenderer = isPrerenderPreset(preset);
  const rootDir = options.root ?? nitro.options.rootDir;
  const log = toHypLogger(nitro);
  const loaded: LoadedHypConfig = await loadHypConfig(rootDir, options.config);
  const assetPrefixes = options.assetPrefixes ?? ['/assets/'];
  const frameworkName: FrameworkName = options.framework?.name ?? 'nitro';
  const host = options.framework?.host ?? frameworkName;
  const exportsModule = options.cloudflare?.exports ? join(rootDir, options.cloudflare.exports) : null;

  const state: {
    prerendered: PrerenderedRoute[];
    result: FinalizeResult | null;
    finalizedWith: number;
    pending: Promise<FinalizeResult> | null;
    /** The Vite client manifest, read once: the public output's copy is removed after the first build step. */
    clientManifest?: ViteManifest | null;
  } = { prerendered: [], result: null, finalizedWith: -1, pending: null };

  const framework = (): ManifestFramework => {
    const version =
      options.framework?.version ??
      packageVersion(rootDir, major === 3 ? 'nitro' : 'nitropack') ??
      nitro.meta?.version ??
      '0.0.0';
    const bundlerVersion = options.framework?.bundlerVersion ?? viteVersion(rootDir);
    const bundler = options.framework?.bundler ?? (nitro.options.builder === 'vite' ? 'vite' : undefined);
    return {
      name: frameworkName,
      version,
      ...(bundler ? { bundler } : {}),
      ...(bundler && bundlerVersion ? { bundlerVersion } : {}),
      ...(preset ? { adapter: preset } : {}),
    };
  };

  const handlers = (): NitroHandlerLike[] =>
    major === 3
      ? (nitro.routing?.routes?.routes ?? [])
      : [...(nitro.scannedHandlers ?? []), ...(nitro.options.handlers ?? [])];

  const routes = async (): Promise<DiscoveredRoute[]> => {
    const pages = options.routes ? await options.routes({ nitro, rootDir, major }) : [];
    return discoverNitroRoutes({
      pages,
      handlers: handlers(),
      renderer: nitro.options.renderer,
      assetPrefixes,
      ...(options.isPage ? { isPage: options.isPage } : {}),
    });
  };

  const target = (): NitroTarget => {
    const platform = loaded.resolved.platform;
    return platform !== 'auto' ? platform : targetOfPreset(preset);
  };

  const runtimeOptions = (): NitroRuntimeOptions => {
    const runtimeTarget = dev ? undefined : target();
    return {
      ...(runtimeTarget ? { target: runtimeTarget } : {}),
      host,
      assetPrefixes,
      nonce: options.nonce !== false,
      socketIp: (runtimeTarget ?? 'node') === 'node' && loaded.resolved.security.trustedProxies === 0,
    };
  };

  const finalize = (force = false): Promise<FinalizeResult> => {
    if (state.result && !force) return Promise.resolve(state.result);
    if (state.pending) return state.pending;
    const pending = (async () => {
      const publicDir = nitro.options.output.publicDir;
      if (state.clientManifest === undefined)
        state.clientManifest = options.clientManifest
          ? await options.clientManifest({ publicDir, rootDir })
          : readViteManifest(publicDir);
      const clientManifest = state.clientManifest;
      const result = await finalizeNitroManifest({
        rootDir,
        config: loaded.resolved,
        framework: framework(),
        baseURL: nitro.options.baseURL || '/',
        routes: await routes(),
        prerendered: state.prerendered,
        publicDir,
        clientManifest,
        assetPrefixes,
        ...(options.internalPages ? { internalPages: options.internalPages } : {}),
        ...(options.pageAssets ? { pageAssets: options.pageAssets } : {}),
        log,
      });
      assertFinalized(result);
      state.result = result;
      state.finalizedWith = state.prerendered.length;
      return result;
    })().finally(() => {
      state.pending = null;
    });
    state.pending = pending;
    return pending;
  };

  // Virtual modules the runtime files import. The manifest module finalises the build on first load, so the
  // server bundle always embeds the final manifest whichever hook order the Nitro version has.
  nitro.options.virtual[VIRTUAL_CONFIG] = () => configModuleCode(loaded);
  nitro.options.virtual[VIRTUAL_MANIFEST] = async () => {
    const buildOnly = !dev && !prerenderer;
    const manifest = buildOnly
      ? (await finalize()).manifest
      : developmentManifest(framework(), await routes());
    return manifestModuleCode(manifest as HypManifest);
  };
  nitro.options.virtual[VIRTUAL_OPTIONS] = () => `export default ${JSON.stringify(runtimeOptions())};\n`;
  nitro.options.virtual[VIRTUAL_CLOUDFLARE_EXPORTS] = () =>
    cloudflareExportsCode(exportsModule, durableObjectsEntry());

  // The runtime plugin. Nitro 3 runs plugins in order and an async one postpones the rest, so Hypdriv goes first.
  const plugin = runtimeFile(major === 3 ? 'nitro3/plugin' : 'nitro2/plugin');
  if (major === 3) nitro.options.plugins = [plugin, ...nitro.options.plugins.filter((p) => p !== plugin)];
  else pushUnique(nitro.options.plugins, plugin);

  // Bundle the runtime and Hypdriv's packages: they import the virtual modules and Nitro's build constants.
  const runtimeDir = packageDir();
  if (major === 3) {
    const noExternals = nitro.options.noExternals;
    if (noExternals !== true) {
      nitro.options.noExternals = [
        ...(Array.isArray(noExternals) ? noExternals : []),
        ...bundledModules(runtimeDir),
      ];
    }
    // `@hypdriv/runtime` imports `cloudflare:workers` lazily, only inside workerd.
    nitro.options.builtinModules = pushUnique(
      [...(nitro.options.builtinModules ?? [])],
      'cloudflare:workers',
    );
  } else {
    if (nitro.options.externals !== false) {
      nitro.options.externals ||= {};
      nitro.options.externals.inline ||= [];
      nitro.options.externals.inline.push(...bundledModules(runtimeDir));
    }
    nitro.options.rollupConfig ||= {};
    nitro.options.rollupConfig.external = withExternal(nitro.options.rollupConfig.external, /^cloudflare:/);
    // Nitro's auto-imports must not rewrite the runtime (its `CaptureResponse` has methods named like h3 utils).
    if (nitro.options.imports !== false && nitro.options.imports !== undefined) {
      const exclude = nitro.options.imports.exclude;
      nitro.options.imports.exclude = [
        ...(exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude]),
        new RegExp(`^${escapeRegExp(runtimeDir)}`),
      ];
    }
  }
  // The development server loads server dependencies from disk instead of bundling them: point Hypdriv's packages
  // at the files this module resolves (the application need not depend on them directly).
  if (dev) {
    nitro.options.alias ||= {};
    for (const [specifier, file] of Object.entries(runtimePackages()))
      nitro.options.alias[specifier] ??= file;
  }

  // The prerenderer is a second Nitro instance that renders the routes on Node: runtime and virtual modules only.
  if (prerenderer) return;

  if (!dev && (options.immutableAssets ?? options.assetPrefixes !== undefined))
    immutableAssetRules(nitro, assetPrefixes);

  if (exportsModule && !supportsWorkerEntry(preset) && !dev)
    log.warn(`hypdriv: cloudflare.exports only applies to the cloudflare-module preset (building ${preset})`);

  // The Worker entry: Hypdriv's Worker shell around Nitro, plus the Durable Object and application exports.
  if (!dev && options.cloudflare?.worker !== false && supportsWorkerEntry(preset)) {
    const worker = runtimeFile(major === 3 ? 'nitro3/cloudflare-worker' : 'nitro2/cloudflare-worker');
    const dir = join(nitro.options.buildDir, 'hypdriv');
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, 'cloudflare-entry.mjs');
    writeFileSync(entry, cloudflareEntryCode(worker, major));
    nitro.options.entry = entry;
  }

  // Nitro 3 runs the Cloudflare development server in miniflare with the bindings of wrangler.jsonc, whose Durable
  // Objects the dev entry must export (the builtin dev exports only cover Nitro's own `$DurableObject`).
  if (dev && major === 3 && nitro.options.builder === 'vite' && targetOfPreset(preset) === 'cloudflare') {
    nitro.hooks.hook('build:before', async () => {
      const existing = nitro.options.virtual[DEV_WORKER_EXPORTS];
      const builtin = typeof existing === 'function' ? await existing() : (existing ?? '');
      nitro.options.virtual[DEV_WORKER_EXPORTS] =
        `${builtin}${builtin && !builtin.endsWith('\n') ? '\n' : ''}${cloudflareExportsCode(exportsModule, durableObjectsEntry())}`;
    });
  }

  if (dev) return;

  nitro.hooks.hook('prerender:done', (result: { prerenderedRoutes?: PrerenderedRoute[] }) => {
    state.prerendered = (result.prerenderedRoutes ?? []).map((r) => ({
      route: r.route,
      ...(r.fileName ? { fileName: r.fileName } : {}),
      ...(r.contentType ? { contentType: r.contentType } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.skip ? { skip: r.skip } : {}),
    }));
  });

  // Finalise right before the server bundle (the manifest module also does it on first load).
  // The Vite client manifest has been read by then: it must not end up among the public assets.
  nitro.hooks.hook(major === 3 ? 'vite:compile:before' : 'rollup:before', async () => {
    await finalize();
    removeViteMetadata(nitro.options.output.publicDir);
  });

  nitro.hooks.hook('compiled', async () => {
    // A manifest finalised before the prerenderer finished (an unusual hook order) is rebuilt.
    const result = await finalize(state.result !== null && state.finalizedWith !== state.prerendered.length);
    removeViteMetadata(nitro.options.output.publicDir);
    if (isStaticPreset(preset) && target() === 'node') return;
    const out = completeNitroOutput({
      target: target(),
      config: loaded.resolved,
      result,
      publicDir: nitro.options.output.publicDir,
      outputDir: nitro.options.output.dir,
      serverDir: nitro.options.output.serverDir,
      staticHeaders: options.staticHeaders !== false,
      log,
    });
    if (target() === 'vercel' && options.staticHeaders !== false)
      await addVercelMiddleware({
        root: rootDir,
        outputDir: nitro.options.output.dir,
        config: loaded,
        manifest: result.manifest as HypManifest,
        paths: options.vercel?.middleware === false ? [] : result.documents.map((d) => d.pathname),
        log,
      });
    if (!out.embedded.length)
      log.warn(
        'hypdriv: no server file embeds the runtime manifest; the Hypdriv Nitro plugin is not part of this build',
      );
    nitro.logger.info(
      `hypdriv: ${target()} output completed (final manifest in ${out.embedded.length} server file(s)${
        out.patched.length ? `, ${out.patched.length} patched` : ''
      }${out.headersFile ? `, static headers in ${relative(rootDir, out.headersFile)}` : ''})`,
    );
  });
}

/**
 * `@hypdriv/nitro` — runs the Hypdriv Drivetrain around every response of a Nitro app (security headers, CSP with
 * nonces and hashes, rate limiting, bot shield, geo, flags, i18n, redirects, maintenance, Early Hints, logging,
 * tracing, Server-Timing, `/_hypdriv/*`) and writes the build manifest and the platform's static headers. One
 * module serves Nitro 2 (`nitropack`) and Nitro 3 (`nitro`), on Cloudflare Workers, Vercel and Node.
 *
 * ```ts
 * // nitro.config.ts
 * import { defineConfig } from 'nitro';
 * import { hypdrivNitro } from '@hypdriv/nitro';
 *
 * export default defineConfig({ modules: [hypdrivNitro()] });
 * ```
 */
export function hypdrivNitro(options: HypdrivNitroOptions = {}): NitroModuleLike {
  return { name: '@hypdriv/nitro', setup: (nitro) => setupNitro(nitro, options) };
}

/** A Nitro config with the Hypdriv module added to its `modules` (for hosts that take a plain Nitro config). */
export function withHypDriv<T extends { modules?: unknown[] }>(
  config: T = {} as T,
  options: HypdrivNitroOptions = {},
): T & { modules: unknown[] } {
  return { ...config, modules: [hypdrivNitro(options), ...(config.modules ?? [])] };
}

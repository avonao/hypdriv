import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { HypDrivConfig, ManifestFramework } from '@hypdriv/core';
import {
  addVercelMiddleware,
  assetsForEntries,
  configModuleCode,
  type DiscoveredRoute,
  developmentManifest,
  finalizeManifest,
  hostPlugin,
  manifestModuleCode,
  patchRuntimeManifest,
  readViteManifest,
  rulesFor,
  type ViteManifest,
  viteLogger,
  writeCloudflareStatic,
  writeVercelStatic,
} from '@hypdriv/vite';
import {
  type Plugin,
  type ViteBuilder,
  type ResolvedConfig as ViteResolvedConfig,
  version as viteVersion,
} from 'vite';
import { DEFAULT_ASSETS_DIR, PRERENDER_PRESET } from './constants';
import { documentsWithNonce, findDocuments } from './documents';
import { applyNodeRouteRules, installNitroModule, nitroPluginPath } from './nitro-module';
import {
  type RouteLayout,
  type SolidRoute,
  scanRouteFiles,
  solidRoutes,
  toDiscoveredRoutes,
  usesServerFunctions,
} from './routes';
import { type NitroLike, type NitroModuleLike, type SolidStartTarget, targetForNitroPreset } from './target';
import { writeVercelOverrides } from './vercel';
import { packageVersion } from './version';

export interface HypDrivSolidStartOptions extends RouteLayout {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the Vite root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * Targets to write static configuration for. Default: detected — `cloudflare` with `@cloudflare/vite-plugin`, the
   * Nitro preset's platform with `nitro()` (`vercel`, `cloudflare-*`, otherwise `node`), else `node`.
   */
  targets?: SolidStartTarget[];
  /**
   * Run Hypdriv's Routing Middleware on Vercel for prerendered pages, which the CDN serves without SolidStart's
   * function (rate limiting, bot shield, maintenance, redirects, geo; default true).
   */
  vercelMiddleware?: boolean;
  /** The Nitro runtime plugin file (default: `@hypdriv/solid-start/nitro`, next to this plugin). */
  nitroPlugin?: string;
}

const BUILD_PLUGIN = 'hypdriv:solid-start-build';
const SOLID_CONFIG_PLUGIN = 'solid-start:config';

const EXTERNAL_BASE = /^([a-z]+:)?\/\//;

/** The path the app is served under: Vite's `base` unless it is a CDN URL (then the app stays at the root). */
function publicBase(base: string | undefined): string {
  const value = base || '/';
  return EXTERNAL_BASE.test(value) ? '/' : value;
}

/**
 * The Hypdriv plugin for SolidStart 2. List it after `solidStart()` and the deployment plugin (`nitro()` or
 * `@cloudflare/vite-plugin`):
 *
 * ```ts
 * plugins: [solidStart(), nitro(), hypdriv()]
 * ```
 *
 * - on Nitro (Node, Vercel, a Nitro-built Cloudflare Worker) registers a Nitro module that wraps `nitroApp.fetch`
 *   with the Drivetrain and serves `virtual:hypdriv/config` and `virtual:hypdriv/manifest` to it; Nitro's prerender
 *   build is left alone;
 * - on `@cloudflare/vite-plugin` serves the same virtual modules to the Worker entry you write
 *   (`@hypdriv/solid-start/cloudflare`);
 * - after the complete build — client, server, Nitro, prerendering — writes `.hypdriv/manifest.json` (pages,
 *   endpoints, per-route assets, CSP hashes of the prerendered documents, Early Hints), fails the build on budget,
 *   Purser or secret-scan failures, patches the final manifest into every server output (`dist/server`,
 *   `.output/server`, `.vercel/output/functions`) and writes the platform's static headers: Cloudflare `_headers`,
 *   Vercel Build Output routes and clean-URL overrides plus Routing Middleware for prerendered pages, Nitro route
 *   rules for a Node server's hashed assets.
 */
export function hypdriv(options: HypDrivSolidStartOptions = {}): Plugin[] {
  let vite: ViteResolvedConfig | null = null;
  let nitro: NitroLike | null = null;
  let finalized = false;
  let target: SolidStartTarget | null = null;

  const layout = (): RouteLayout => ({
    ...(options.appRoot !== undefined ? { appRoot: options.appRoot } : {}),
    ...(options.routeDir !== undefined ? { routeDir: options.routeDir } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });
  const routes = (root: string): SolidRoute[] => solidRoutes(scanRouteFiles(root, layout()));
  const discovered = (root: string): DiscoveredRoute[] =>
    toDiscoveredRoutes(routes(root), { serverFunctions: usesServerFunctions(root, options.appRoot) });

  const assetPrefixes = (): string[] => {
    const base = publicBase(vite?.base).replace(/\/$/, '');
    const dir = vite?.environments?.client?.build?.assetsDir ?? vite?.build.assetsDir ?? DEFAULT_ASSETS_DIR;
    return [`${base}/${dir.replace(/^\/+|\/+$/g, '')}/`];
  };

  const framework = (): ManifestFramework => ({
    name: 'solid-start',
    version: packageVersion(vite?.root ?? process.cwd(), '@solidjs/start') ?? 'unknown',
    bundler: 'vite',
    bundlerVersion: viteVersion,
    ...(target ? { adapter: nitro ? nitro.options.preset : target } : {}),
  });

  const host = hostPlugin({
    name: 'hypdriv:solid-start',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework,
    routes: async () => discovered(host.api.root),
    noExternal: ['@hypdriv/solid-start'],
  });
  const api = host.api;

  const detectTarget = (resolved: ViteResolvedConfig): SolidStartTarget => {
    if (options.targets?.length) return options.targets[0]!;
    if (resolved.plugins.some((p) => p.name.startsWith('vite-plugin-cloudflare'))) return 'cloudflare';
    if (nitro) return targetForNitroPreset(nitro.options.preset);
    return 'node';
  };

  const nitroModule: NitroModuleLike = {
    name: 'hypdriv',
    setup(instance) {
      // Nitro's prerender build runs the same modules: it must neither be remembered as the build's instance nor
      // wrapped with the pipeline.
      installNitroModule(instance, {
        pluginPath: () => nitroPluginPath(api.root, options.nitroPlugin),
        configSource: async () => configModuleCode(await api.config()),
        manifestSource: async () =>
          manifestModuleCode(api.manifest() ?? developmentManifest(framework(), discovered(api.root))),
        assetPrefixes,
      });
      if (instance.options.preset !== PRERENDER_PRESET) nitro = instance;
    },
  };

  const finalize = async (builder: ViteBuilder): Promise<void> => {
    if (finalized || !vite) return;
    finalized = true;
    const root = vite.root;
    const log = viteLogger(vite);
    const loaded = await api.config();
    const clientEnv = builder.environments.client;
    const buildClientDir = resolve(root, clientEnv?.config.build.outDir ?? vite.build.outDir);
    const base = publicBase(vite.base);
    const basePath = base === '/' ? '' : base.replace(/\/$/, '');
    const immutablePrefixes = assetPrefixes();

    target = detectTarget(vite);
    // Nitro copies the client build into its public directory and prerenders into it; without Nitro the client
    // build is what the platform serves.
    const publicDir = nitro ? resolve(root, nitro.options.output.publicDir) : buildClientDir;
    const documents = findDocuments(publicDir, basePath);
    const leaked = documentsWithNonce(documents);
    if (leaked.length)
      throw new Error(
        `hypdriv: prerendered pages carry a per-request CSP nonce (${leaked.join(', ')}): Hypdriv's pipeline ran while Nitro prerendered them. Keep hypdriv() after nitro() in the Vite plugins so the Nitro module skips the prerender build.`,
      );

    const viteManifest: ViteManifest | null = readViteManifest(publicDir) ?? readViteManifest(buildClientDir);
    const solid = routes(root);
    const found = toDiscoveredRoutes(solid, { serverFunctions: usesServerFunctions(root, options.appRoot) });
    const withSources: DiscoveredRoute[] = found.map((route) => {
      const own = solid.find((r) => r.pathname === route.pathname && r.kind === route.kind);
      if (own?.kind !== 'page' || !viteManifest) return route;
      const keys = chunkKeys(
        viteManifest,
        own.files.map((f) => relative(root, f).split('\\').join('/')),
      );
      return keys.length ? { ...route, sources: assetsForEntries(viteManifest, keys, base) } : route;
    });

    // Nitro's Node server answers prerendered paths from its own public-asset table: the pipeline sees those
    // documents and applies their CSP; Vercel's CDN and Workers Static Assets serve them without any code.
    const result = await finalizeManifest({
      documentsServedStatically: target !== 'node',
      root,
      config: loaded.resolved,
      framework: framework(),
      base,
      basePath,
      trailingSlash: false,
      routes: withSources,
      documents,
      clientDir: publicDir,
      ...(viteManifest ? { viteManifest, sharedEntries: sharedEntries(viteManifest) } : {}),
      immutablePrefixes,
      log,
    });
    if (result.failures.length)
      throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
    api.setManifest(result.manifest);

    const rules = rulesFor({
      config: loaded.resolved,
      manifest: result.manifest,
      documents: result.documents,
      immutablePrefixes,
    });
    const targets = new Set<SolidStartTarget>(options.targets?.length ? options.targets : [target]);
    if (targets.has('cloudflare')) writeCloudflareStatic({ assetsDir: publicDir, rules, log });
    if (targets.has('vercel')) {
      const outputDir = nitro ? resolve(root, nitro.options.output.dir) : join(root, '.vercel', 'output');
      if (existsSync(join(outputDir, 'config.json'))) {
        writeVercelStatic({ outputDir, rules, manifestJson: JSON.stringify(result.manifest), log });
        const staticDocuments = documents.filter((d) => d.file.startsWith(join(outputDir, 'static')));
        const mapped = writeVercelOverrides(outputDir, staticDocuments);
        log.info(
          `hypdriv: Vercel Build Output header routes written (${mapped} prerendered page(s) at clean URLs)`,
        );
        // Prerendered pages are served by Vercel's CDN without SolidStart's function: Hypdriv's Routing Middleware
        // runs the request stages for them (the function keeps running them for everything else).
        await addVercelMiddleware({
          root,
          outputDir,
          config: loaded,
          manifest: result.manifest,
          paths: options.vercelMiddleware === false ? [] : staticDocuments.map((d) => d.pathname),
          log,
        });
      } else
        log.warn(
          `hypdriv: no Vercel Build Output at ${outputDir}; build with Nitro's \`vercel\` preset (VERCEL=1 sets it)`,
        );
    }

    const patched = patchRuntimeManifest(serverOutputDirs(root, builder, vite, nitro), result.manifest);
    if (patched.length) log.info(`hypdriv: final manifest patched into ${patched.length} server file(s)`);
    else
      log.warn(
        'hypdriv: no server output embeds the Hypdriv manifest; add nitro() (Node, Vercel) or the Worker entry of @hypdriv/solid-start/cloudflare (Cloudflare) to the Vite plugins',
      );
  };

  const build: Plugin & { nitro: NitroModuleLike } = {
    name: BUILD_PLUGIN,
    enforce: 'post',
    sharedDuringBuild: true,
    nitro: nitroModule,
    async configResolved(resolved) {
      vite = resolved;
      const names = resolved.plugins.map((p) => p.name);
      if (!names.includes(SOLID_CONFIG_PLUGIN)) {
        const message = 'hypdriv(): @hypdriv/solid-start/vite needs solidStart() in the Vite plugins';
        if (resolved.command === 'build') throw new Error(message);
        resolved.logger.warn(message);
      }
      if (resolved.command === 'build') {
        const own = names.indexOf(BUILD_PLUGIN);
        const lastNitro = names.reduce((at, name, i) => (/^nitro(?::|-|$)/.test(name) ? i : at), -1);
        if (lastNitro > own)
          throw new Error(
            'hypdriv(): list hypdriv() after nitro() in the Vite plugins: it finalises the manifest once Nitro has built and prerendered',
          );
      }
      // A Node server's hashed assets are served by Nitro before any application code runs: give them the static
      // rules through Nitro's route rules (Vercel and Cloudflare get theirs from the build output).
      if (resolved.command === 'build' && nitro) {
        const loaded = await api.config();
        applyNodeRouteRules(nitro, loaded.resolved, assetPrefixes());
      }
    },
    buildApp: {
      order: 'post',
      async handler(builder) {
        await finalize(builder);
      },
    },
  };

  return [host, build];
}

/** The client entries every page loads (the manifest entries without a route `?pick=` query). */
function sharedEntries(manifest: ViteManifest): string[] {
  return Object.entries(manifest)
    .filter(([key, chunk]) => chunk.isEntry === true && !key.includes('?'))
    .map(([key]) => key);
}

/**
 * The manifest entries of route modules: SolidStart builds every route file as `src/routes/about.tsx?pick=default&…`,
 * so the entry for a source file is the key with that file before the query.
 */
export function chunkKeys(manifest: ViteManifest, sources: string[]): string[] {
  const wanted = new Set(sources);
  return Object.keys(manifest).filter((key) => wanted.has(key.split('?')[0] as string));
}

/**
 * Every directory a deployment runs server code from: the output of each non-client environment (`dist/server`,
 * the Worker bundle) and Nitro's final server output (`.output/server`, `.vercel/output/functions/*.func`).
 */
function serverOutputDirs(
  root: string,
  builder: ViteBuilder,
  vite: ViteResolvedConfig,
  nitro: NitroLike | null,
): string[] {
  const dirs = new Set<string>();
  for (const [name, env] of Object.entries(builder.environments)) {
    if (name === 'client' || env.config.consumer === 'client') continue;
    const outDir = env.config.build.outDir;
    if (outDir) dirs.add(resolve(root, outDir));
  }
  for (const [name, env] of Object.entries(vite.environments ?? {})) {
    if (name === 'client' || env.consumer === 'client') continue;
    if (env.build?.outDir) dirs.add(resolve(root, env.build.outDir));
  }
  if (nitro) {
    dirs.add(resolve(root, nitro.options.output.serverDir));
    if (targetForNitroPreset(nitro.options.preset) === 'vercel')
      dirs.add(resolve(root, nitro.options.output.dir, 'functions'));
  }
  return [...dirs].filter((d) => existsSync(d));
}

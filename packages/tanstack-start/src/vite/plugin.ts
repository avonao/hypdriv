import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { staticHeaderRules } from '@hypdriv/build';
import { emptyManifest, type HypDrivConfig, type ManifestFramework } from '@hypdriv/core';
import {
  type DiscoveredRoute,
  finalizeManifest,
  hostPlugin,
  patchRuntimeManifest,
  rulesFor,
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
import { VIRTUAL_START } from '../constants';
import { type ClientChunk, clientChunksFrom, type OutputChunkLike, routeSources } from './assets';
import { documentsWithNonce, findDocuments } from './documents';
import { type StartOptionsLike, startRegistration } from './options';
import {
  crawlStartRoutes,
  routerBasePath,
  type StartRoute,
  startRoutesFromNodes,
  toDiscoveredRoutes,
} from './routes';
import {
  type NitroLike,
  type NitroModuleLike,
  nodeRouteRules,
  type StartTarget,
  scrubPrerenderToken,
  targetForNitroPreset,
  writeVercelOverrides,
} from './targets';

export interface HypDrivStartPluginOptions {
  /** The HypDriv config: a file path (default `hypdriv.config.*` in the Vite root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * Targets to write static configuration for. Default: detected — `cloudflare` with `@cloudflare/vite-plugin`,
   * the Nitro preset's platform with `nitro()` (`vercel`, `cloudflare-*`, otherwise `node`), else `node`.
   */
  targets?: StartTarget[];
  /**
   * TanStack Start's options, for route discovery, when they are not passed through `withHypDriv()` (which
   * registers them, and which prerendering needs anyway).
   */
  start?: StartOptionsLike;
}

const RESOLVED_START = `\0${VIRTUAL_START}`;
const START_POST_BUILD = 'tanstack-start-core:post-build';
const BUILD_PLUGIN = 'hypdriv:tanstack-start-build';

/** The version of an installed package, resolved from the project root (`unknown` when it cannot be found). */
export function packageVersion(root: string, name: string): string | null {
  try {
    const require = createRequire(join(root, 'package.json'));
    const file = require.resolve(`${name}/package.json`);
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    try {
      const require = createRequire(join(root, 'package.json'));
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 8; i++) {
        const file = join(dir, 'package.json');
        if (existsSync(file)) {
          const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
          if (pkg.name === name) return pkg.version ?? null;
        }
        dir = dirname(dir);
      }
    } catch {
      // not installed
    }
    return null;
  }
}

/**
 * The HypDriv plugin for TanStack Start. List it after `tanstackStart()` (and `nitro()`):
 *
 * ```ts
 * plugins: [tanstackStart(withHypDriv({ ... })), nitro(), viteReact(), hypdriv()]
 * ```
 *
 * - serves `virtual:hypdriv/config`, `virtual:hypdriv/manifest` (routes discovered with TanStack's generator) and
 *   the prerender token to the server code of `@hypdriv/tanstack-start`;
 * - after the complete build — client, server, Nitro, prerendering — writes `.hypdriv/manifest.json` (pages,
 *   endpoints, per-route assets, CSP hashes of the prerendered documents, Early Hints), fails the build on budget,
 *   Purser or secret-scan failures, patches the final manifest into every server output (`dist/server`,
 *   `.output/server`, `.vercel/output/functions`), removes the prerender token from it, and writes the platform's
 *   static headers: Cloudflare `_headers`, Vercel Build Output routes and clean-URL overrides, Nitro `routeRules`
 *   for a Node server's hashed assets.
 */
export function hypdriv(options: HypDrivStartPluginOptions = {}): Plugin[] {
  let vite: ViteResolvedConfig | null = null;
  let nitro: NitroLike | null = null;
  let chunks: ClientChunk[] = [];
  let discovered: Promise<StartRoute[]> | null = null;
  let finalized = false;
  let target: StartTarget | null = null;

  const startOptions = (): StartOptionsLike => options.start ?? startRegistration()?.options ?? {};
  const startVersion = (root: string) =>
    packageVersion(root, '@tanstack/react-start') ??
    packageVersion(root, '@tanstack/solid-start') ??
    'unknown';
  const framework = (): ManifestFramework => ({
    name: 'tanstack-start',
    version: startVersion(vite?.root ?? process.cwd()),
    bundler: 'vite',
    bundlerVersion: viteVersion,
    ...(target ? { adapter: nitro ? nitro.options.preset : target } : {}),
  });

  const discover = (root: string): Promise<StartRoute[]> => {
    discovered ??= crawlStartRoutes(root, startOptions())
      .then((nodes) => startRoutesFromNodes(nodes, root))
      .catch((err: unknown) => {
        discovered = null;
        throw new Error(
          `hypdriv: route discovery failed (${(err as Error).message}). Pass TanStack Start's options through withHypDriv() so HypDriv reads the same router configuration.`,
          { cause: err },
        );
      });
    return discovered;
  };

  const host = hostPlugin({
    name: 'hypdriv:tanstack-start',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework,
    routes: async () => {
      try {
        return toDiscoveredRoutes(await discover(host.api.root), startOptions());
      } catch (err) {
        // The build fails on it (finalize); the development manifest only informs logs and DevTools.
        if (host.api.isBuild()) throw err;
        (vite ? viteLogger(vite) : console).warn((err as Error).message);
        return toDiscoveredRoutes([], startOptions());
      }
    },
    noExternal: ['@hypdriv/tanstack-start'],
  });
  const api = host.api;

  const token: Plugin = {
    name: 'hypdriv:tanstack-start-token',
    enforce: 'pre',
    sharedDuringBuild: true,
    resolveId(id) {
      return id === VIRTUAL_START ? RESOLVED_START : null;
    },
    load(id) {
      if (id !== RESOLVED_START) return null;
      const value = api.isBuild() ? (startRegistration()?.token ?? '') : '';
      return `export const prerenderToken = ${JSON.stringify(value)};\n`;
    },
  };

  const collect: Plugin = {
    name: 'hypdriv:tanstack-start-assets',
    sharedDuringBuild: true,
    generateBundle: {
      order: 'post',
      handler(_output, bundle) {
        const env = (this as { environment?: { name?: string; config?: { consumer?: string } } }).environment;
        if (env?.name !== 'client' && env?.config?.consumer !== 'client') return;
        chunks = clientChunksFrom(bundle as unknown as Record<string, OutputChunkLike>);
      },
    },
  };

  const detectTarget = (resolved: ViteResolvedConfig): StartTarget => {
    if (options.targets?.length) return options.targets[0]!;
    if (resolved.plugins.some((p) => p.name.startsWith('vite-plugin-cloudflare'))) return 'cloudflare';
    if (nitro) return targetForNitroPreset(nitro.options.preset);
    return 'node';
  };

  const nitroModule: NitroModuleLike = {
    name: 'hypdriv',
    setup(instance) {
      nitro = instance;
    },
  };

  const finalize = async (builder: ViteBuilder): Promise<void> => {
    if (finalized || !vite) return;
    finalized = true;
    const root = vite.root;
    const log = viteLogger(vite);
    const loaded = await api.config();
    const opts = startOptions();
    const clientEnv = builder.environments.client;
    const clientDir = resolve(root, clientEnv?.config.build.outDir ?? vite.build.outDir);
    const base = vite.base || '/';
    const assetsDir = clientEnv?.config.build.assetsDir ?? vite.build.assetsDir ?? 'assets';
    const immutablePrefixes = [`${base.replace(/\/$/, '')}/${assetsDir}/`];
    const basePath = routerBasePath(opts);
    const registration = startRegistration();

    const documents = findDocuments(clientDir, basePath);
    const leaked = documentsWithNonce(documents);
    if (leaked.length)
      throw new Error(
        `hypdriv: prerendered pages carry a per-request CSP nonce (${leaked.join(', ')}): HypDriv's middleware ran while TanStack Start prerendered them. Pass the options of tanstackStart() through withHypDriv() so prerender requests are recognised.`,
      );
    if (documents.length && !registration && !options.start)
      log.warn(
        'hypdriv: TanStack Start prerendered pages but its options were not passed through withHypDriv(): prerender requests ran through the HypDriv pipeline. Use tanstackStart(withHypDriv({ ... })).',
      );

    const startRoutes = await discover(root);
    const routes: DiscoveredRoute[] = toDiscoveredRoutes(startRoutes, opts).map((route) => {
      const own = startRoutes.find((r) => r.pathname === route.pathname && r.kind === route.kind);
      if (own?.kind !== 'page' || !chunks.length) return route;
      return { ...route, sources: routeSources(chunks, own.files, base) };
    });

    target = detectTarget(vite);
    // Nitro's Node server renders prerendered paths again at request time (its public-asset table is built
    // before Start prerenders): their documents are not what visitors get.
    const servedStatically = { documentsServedStatically: target !== 'node' };
    const result = await finalizeManifest({
      ...servedStatically,
      root,
      config: loaded.resolved,
      framework: framework(),
      base,
      basePath,
      trailingSlash: false,
      routes,
      documents,
      clientDir,
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
    const targets = new Set<StartTarget>(options.targets?.length ? options.targets : [target]);
    if (targets.has('cloudflare')) writeCloudflareStatic({ assetsDir: clientDir, rules, log });
    if (targets.has('vercel')) {
      const outputDir = nitro ? resolve(root, nitro.options.output.dir) : join(root, '.vercel', 'output');
      if (existsSync(join(outputDir, 'config.json'))) {
        writeVercelStatic({ outputDir, rules, manifestJson: JSON.stringify(result.manifest), log });
        const mapped = writeVercelOverrides(
          outputDir,
          documents.filter((d) => d.file.startsWith(join(outputDir, 'static'))),
        );
        log.info(
          `hypdriv: Vercel Build Output header routes written (${mapped} prerendered page(s) at clean URLs)`,
        );
      } else
        log.warn(
          `hypdriv: no Vercel Build Output at ${outputDir}; build with Nitro's \`vercel\` preset (VERCEL=1 sets it)`,
        );
    }

    const serverDirs = serverOutputDirs(root, builder, vite, nitro);
    const patched = patchRuntimeManifest(serverDirs, result.manifest);
    if (patched.length) log.info(`hypdriv: final manifest patched into ${patched.length} server file(s)`);
    else
      log.warn(
        'hypdriv: no server output embeds the HypDriv manifest; register hypdrivMiddleware() in src/start.ts (or use createStartWorker / the server entry)',
      );
    if (registration) {
      const scrubbed = scrubPrerenderToken(serverDirs, registration.token);
      if (scrubbed.length)
        log.info(`hypdriv: prerender token removed from ${scrubbed.length} server file(s)`);
    }
  };

  const build: Plugin & { nitro: NitroModuleLike } = {
    name: BUILD_PLUGIN,
    enforce: 'post',
    sharedDuringBuild: true,
    nitro: nitroModule,
    async configResolved(resolved) {
      vite = resolved;
      if (resolved.command !== 'build') return;
      const names = resolved.plugins.map((p) => p.name);
      const startPostBuild = names.indexOf(START_POST_BUILD);
      if (startPostBuild < 0)
        throw new Error('hypdriv(): @hypdriv/tanstack-start/vite needs tanstackStart() in the Vite plugins');
      if (startPostBuild > names.indexOf(BUILD_PLUGIN))
        throw new Error(
          'hypdriv(): list hypdriv() after tanstackStart() (and nitro()) in the Vite plugins: it finalises the manifest after prerendering',
        );
      // A Node server's hashed assets are served by Nitro before any application code runs: give them the
      // static rules through Nitro's route rules (Vercel and Cloudflare get theirs from the build output).
      if (nitro && targetForNitroPreset(nitro.options.preset) === 'node') {
        const loaded = await api.config();
        const assetsDir =
          resolved.environments.client?.build.assetsDir ?? resolved.build.assetsDir ?? 'assets';
        const prefix = `${(resolved.base || '/').replace(/\/$/, '')}/${assetsDir}/`;
        const rules = staticHeaderRules({
          config: loaded.resolved,
          manifest: emptyManifest(),
          documents: [],
          immutablePrefixes: [prefix],
        });
        for (const [pattern, rule] of Object.entries(nodeRouteRules(rules))) {
          const current = nitro.options.routeRules[pattern] ?? {};
          const headers = current.headers === false ? undefined : current.headers;
          nitro.options.routeRules[pattern] = { ...current, headers: { ...rule.headers, ...headers } };
        }
      }
    },
    buildApp: {
      order: 'post',
      async handler(builder) {
        await finalize(builder);
      },
    },
  };

  return [host, token, collect, build];
}

/**
 * Every directory a deployment runs server code from: the output of each non-client environment (`dist/server`
 * for Workers, Nitro's intermediate `ssr` service) and Nitro's final server output (`.output/server`,
 * `.vercel/output/functions/*.func`).
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

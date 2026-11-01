import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { HypDrivConfig, ManifestFramework } from '@hypdriv/core';
import {
  type DiscoveredRoute,
  finalizeManifest,
  hostPlugin,
  patchRuntimeManifest,
  readViteManifest,
  rulesFor,
  viteLogger,
  writeCloudflareStatic,
} from '@hypdriv/vite';
import {
  type Plugin,
  type ViteBuilder,
  type ResolvedConfig as ViteResolvedConfig,
  version as viteVersion,
} from 'vite';
import { findWorkerEntry, rwsdkVersion } from './entry';
import { discoveredRoutes, scanWorkerRoutes } from './scan';

export interface HypDrivRwsdkOptions {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * The Worker entry (`src/worker.tsx`), when it is not the `main` of the Wrangler config. The build reads the app's
   * routes from it, and the plugin exports the Durable Object classes from it.
   */
  entry?: string;
  /**
   * Routes the build cannot read from the source (a path computed at run time, routes a function builds): added to
   * the scanned ones, or a function that returns the final list. The Worker reads the exact routes from the
   * running app either way.
   */
  routes?: DiscoveredRoute[] | ((discovered: DiscoveredRoute[]) => DiscoveredRoute[]);
  /**
   * Export the Durable Object classes Hypdriv's features use (`HypDrivLimiter`, `HypDrivIndex`, `HypDrivChannel`)
   * from the Worker entry, so the bindings in `wrangler.jsonc` resolve without an export of your own (default true).
   */
  durableObjects?: boolean;
}

/** The module the plugin appends to the Worker entry: the Durable Object classes. */
export const VIRTUAL_DURABLE_OBJECTS = 'virtual:hypdriv/durable-objects';
const RESOLVED_DURABLE_OBJECTS = `\0${VIRTUAL_DURABLE_OBJECTS}`;

/** RedwoodSDK builds its Worker in the Vite environment of this name (`cloudflare({ viteEnvironment })`). */
const WORKER_ENVIRONMENT = 'worker';

/** Adds the routes of the `routes` option to the discovered ones (a route given by the option wins). */
export function mergeRoutes(
  discovered: DiscoveredRoute[],
  option: HypDrivRwsdkOptions['routes'],
): DiscoveredRoute[] {
  if (!option) return discovered;
  if (typeof option === 'function') return option(discovered);
  const extra = new Set(option.map((r) => `${r.kind}:${r.pathname}`));
  return [...discovered.filter((r) => !extra.has(`${r.kind}:${r.pathname}`)), ...option];
}

/** The directory of a path with a trailing slash removed: Vite's `base` (`/` or `/app/`) as `''` or `/app`. */
const basePathOf = (base: string): string => (base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`);

/**
 * The Hypdriv plugin for RedwoodSDK. Add it to `vite.config.mts` next to `redwood()`:
 *
 * ```ts
 * // vite.config.mts
 * import { cloudflare } from '@cloudflare/vite-plugin';
 * import { hypdriv } from '@hypdriv/rwsdk';
 * import { redwood } from 'rwsdk/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({
 *   environments: { ssr: {} },
 *   plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()],
 * });
 * ```
 *
 * - Serves `virtual:hypdriv/config` and `virtual:hypdriv/manifest` to the Worker (`@hypdriv/rwsdk/worker` imports
 *   them) and exports the Durable Object classes from the Worker entry.
 * - After RedwoodSDK's multi-pass build writes `.hypdriv/manifest.json` (the routes read from `src/worker.tsx`, the
 *   client assets of the build for Early Hints and budgets, the Purser and secrets checks), patches it into the
 *   built Worker (`dist/worker`) and writes the static headers (`dist/client/_headers`) of the hashed assets.
 */
export function hypdriv(options: HypDrivRwsdkOptions = {}): Plugin[] {
  let root = process.cwd();
  let vite: ViteResolvedConfig | null = null;
  let finalized = false;
  let entry = '';
  const worker = () => (entry ||= findWorkerEntry(root, options.entry));

  const framework = (): ManifestFramework => ({
    name: 'rwsdk',
    version: rwsdkVersion(root),
    bundler: 'vite',
    bundlerVersion: viteVersion,
    adapter: 'cloudflare',
  });
  const scan = () => scanWorkerRoutes(root, worker());
  const routes = (): DiscoveredRoute[] => mergeRoutes(discoveredRoutes(root, scan().routes), options.routes);

  const host = hostPlugin({
    name: 'hypdriv:rwsdk',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework,
    routes,
    noExternal: ['@hypdriv/rwsdk'],
  });
  const api = host.api;

  const entryPlugin: Plugin = {
    name: 'hypdriv:rwsdk-entry',
    enforce: 'pre',
    sharedDuringBuild: true,
    configEnvironment(_name, environment) {
      // The Worker code imports the virtual modules: Vite transforms and bundles it, never pre-bundles or loads it as is.
      if (environment.consumer === 'client') return {};
      return { resolve: { noExternal: ['@hypdriv/rwsdk'] }, optimizeDeps: { exclude: ['@hypdriv/rwsdk'] } };
    },
    configResolved(resolved) {
      root = resolved.root;
      vite = resolved;
      entry = '';
    },
    resolveId(id) {
      return id === VIRTUAL_DURABLE_OBJECTS ? RESOLVED_DURABLE_OBJECTS : null;
    },
    load(id) {
      if (id !== RESOLVED_DURABLE_OBJECTS) return null;
      // Resolved from this package, not the application: `@hypdriv/cloudflare` is the plugin's own dependency.
      let file: string;
      try {
        file = createRequire(import.meta.url).resolve('@hypdriv/rwsdk/durable-objects');
      } catch {
        file = '@hypdriv/rwsdk/durable-objects';
      }
      return `export * from ${JSON.stringify(file)};\n`;
    },
    transform(code, id) {
      if (options.durableObjects === false) return null;
      const environment = (this as { environment?: { name?: string } }).environment;
      if (environment?.name !== WORKER_ENVIRONMENT) return null;
      if ((id.split('?')[0] as string).split('\\').join('/') !== worker()) return null;
      if (code.includes(VIRTUAL_DURABLE_OBJECTS)) return null;
      return { code: `${code}\nexport * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)};\n`, map: null };
    },
  };

  const finalize = async (builder: ViteBuilder): Promise<void> => {
    if (finalized || !vite) return;
    finalized = true;
    const log = viteLogger(vite);
    const client = builder.environments.client;
    const workerEnvironment = builder.environments[WORKER_ENVIRONMENT];
    if (!client || !workerEnvironment)
      throw new Error(
        `hypdriv: the RedwoodSDK build has no \`${WORKER_ENVIRONMENT}\` environment; add \`cloudflare({ viteEnvironment: { name: '${WORKER_ENVIRONMENT}' } })\` and \`redwood()\` to vite.config.mts`,
      );
    const loaded = await api.config();
    const clientDir = resolve(root, client.config.build.outDir);
    const workerDir = resolve(root, workerEnvironment.config.build.outDir);
    const base = vite.base || '/';
    const basePath = basePathOf(base);
    // RedwoodSDK nests the client output under the base path: the assets are served from there.
    const contentDir = basePath ? join(clientDir, basePath.slice(1)) : clientDir;
    const assetsDir = client.config.build.assetsDir || 'assets';
    const immutablePrefixes = [`${basePath}/${assetsDir}/`];

    const scanned = scan();
    if (scanned.warnings.length)
      log.warn(
        `hypdriv: the routes of ${worker().replace(`${root.split('\\').join('/')}/`, '')} could not all be read:\n${scanned.warnings.map((w) => `  - ${w}`).join('\n')}\n  The Worker reads the exact routes from the running app; list them in the manifest with the plugin's \`routes\` option.`,
      );
    if (!scanned.wrapped)
      log.warn(
        "hypdriv: the Worker entry does not use withHypDriv() from '@hypdriv/rwsdk/worker', so the Drivetrain does not run: export default withHypDriv(defineApp([...]))",
      );
    else if (!scanned.middleware)
      log.warn(
        "hypdriv: the Worker entry's defineApp([...]) has no hypdrivMiddleware() from '@hypdriv/rwsdk/worker': RedwoodSDK renders with its own nonce, which a nonce CSP does not allow. Put hypdrivMiddleware() first.",
      );

    const viteManifest = readViteManifest(contentDir);
    const sharedEntries = Object.entries(viteManifest ?? {})
      .filter(([, chunk]) => chunk.isEntry)
      .map(([key]) => key);
    const result = await finalizeManifest({
      root,
      config: loaded.resolved,
      framework: framework(),
      base,
      basePath,
      trailingSlash: false,
      routes: mergeRoutes(discoveredRoutes(root, scanned.routes), options.routes),
      // RedwoodSDK renders every page per request: there are no prerendered documents.
      documents: [],
      clientDir: contentDir,
      ...(viteManifest ? { viteManifest, sharedEntries } : {}),
      immutablePrefixes,
      documentsServedStatically: false,
      log,
    });
    if (result.failures.length)
      throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
    api.setManifest(result.manifest);

    writeCloudflareStatic({
      assetsDir: clientDir,
      rules: rulesFor({
        config: loaded.resolved,
        manifest: result.manifest,
        documents: result.documents,
        immutablePrefixes,
      }),
      log,
    });
    const patched = patchRuntimeManifest(existsSync(workerDir) ? [workerDir] : [], result.manifest);
    if (patched.length) log.info(`hypdriv: final manifest patched into ${patched.length} Worker file(s)`);
    else
      log.warn(
        `hypdriv: no Worker output under ${workerDir} embeds the Hypdriv manifest, so the pipeline does not run: use withHypDriv() from '@hypdriv/rwsdk/worker' in the Worker entry`,
      );
  };

  const build: Plugin = {
    name: 'hypdriv:rwsdk-build',
    apply: 'build',
    enforce: 'post',
    sharedDuringBuild: true,
    buildApp: {
      // After RedwoodSDK's own `buildApp` (the worker, SSR, client and linker passes).
      order: 'post',
      async handler(builder) {
        await finalize(builder);
      },
    },
  };

  return [host, entryPlugin, build];
}

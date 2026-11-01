import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative, resolve } from 'node:path';
import type { HypDrivConfig, ManifestFramework } from '@hypdriv/core';
import {
  addVercelMiddleware,
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
import { findDocuments } from './documents';
import { discoverRoutes } from './routes';
import { resolveTarget, type WakuTarget } from './target';
import { writeVercelOverrides } from './vercel';

export interface HypDrivWakuOptions {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * The deploy target. Default: `HYPDRIV_TARGET`, else `cloudflare` with `@cloudflare/vite-plugin` in the Vite
   * plugins, `vercel` when building on Vercel (`VERCEL=1`), else `node`.
   */
  target?: WakuTarget;
  /** Waku's `srcDir` (default `src`): where `pages/` and a custom `waku.server.*` live. */
  srcDir?: string;
  /**
   * Routes the plugin cannot read from `src/pages` and the literal `createPage` / `createApi` calls of
   * `src/waku.server.*` (computed paths): added to them, or a function that returns the final list.
   */
  routes?: DiscoveredRoute[] | ((discovered: DiscoveredRoute[]) => DiscoveredRoute[]);
  /** Vercel: build Hypdriv's Routing Middleware so the request stages run for the CDN's prerendered pages (default true). */
  vercelMiddleware?: boolean;
  /**
   * Cloudflare: export the Durable Object classes Hypdriv's features use (`HypDrivLimiter`, `HypDrivIndex`,
   * `HypDrivChannel`) from the Worker entry, so the bindings in `wrangler.jsonc` resolve without a Worker file of
   * your own (default true).
   */
  durableObjects?: boolean;
}

/** Waku's server entry module for the Worker / Node server (`waku/dist/lib/vite-entries/entry.server.js`). */
const WAKU_SERVER_ENTRY = /[\\/]waku[\\/]dist[\\/]lib[\\/]vite-entries[\\/]entry\.server\.js$/;

/** The module the plugin appends to Waku's server entry on Cloudflare: the Durable Object classes. */
export const VIRTUAL_DURABLE_OBJECTS = 'virtual:hypdriv/durable-objects';
const RESOLVED_DURABLE_OBJECTS = `\0${VIRTUAL_DURABLE_OBJECTS}`;

/** The Worker `main` of Waku's managed mode: the managed server entry and the Durable Object classes. */
export const VIRTUAL_WORKER_MAIN = 'virtual:hypdriv/waku-worker';
const RESOLVED_WORKER_MAIN = `\0${VIRTUAL_WORKER_MAIN}`;

const SERVER_ENTRY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];

/** Whether the project has its own `waku.server.*` (Waku's explicit mode) in `srcDir`. */
export function hasServerEntry(srcDirectory: string): boolean {
  return SERVER_ENTRY_EXTENSIONS.some((extension) =>
    existsSync(join(srcDirectory, `waku.server${extension}`)),
  );
}

/**
 * Whether `id` names Waku's server entry as a wrangler `main` does (`./src/waku.server`, `src/waku.server`, or its
 * absolute path) while the project has none. Waku's own lookup of the entry uses the root-relative form
 * (`/src/waku.server`), which is never matched, so a project file always wins.
 */
export function isManagedWorkerMain(id: string, root: string, srcDirectory: string): boolean {
  const path = id.split('?')[0] as string;
  if (!/(^|[\\/])waku\.server(\.[cm]?[jt]sx?)?$/.test(path)) return false;
  if (path.startsWith('\0') || (path.startsWith('/') && !path.startsWith(root.split('\\').join('/'))))
    return false;
  const entry = join(srcDirectory, 'waku.server');
  const given = resolve(root, path);
  const candidates = [entry, ...SERVER_ENTRY_EXTENSIONS.map((extension) => `${entry}${extension}`)];
  return candidates.includes(given) && !hasServerEntry(srcDirectory);
}

/** The installed Waku version (`waku/package.json` is exported), or `unknown`. */
export function wakuVersion(root: string): string {
  try {
    const file = createRequire(join(root, 'package.json')).resolve('waku/package.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Adds the routes of the `routes` option to the discovered ones (a route given by the option wins). */
export function mergeRoutes(
  discovered: DiscoveredRoute[],
  option: HypDrivWakuOptions['routes'],
): DiscoveredRoute[] {
  if (!option) return discovered;
  if (typeof option === 'function') return option(discovered);
  const extra = new Set(option.map((r) => `${r.kind}:${r.pathname}`));
  return [...discovered.filter((r) => !extra.has(`${r.kind}:${r.pathname}`)), ...option];
}

/** Waku defines its `rscBase` for the client and server code; the plugin reads it back (default `RSC`). */
function rscBaseOf(vite: ViteResolvedConfig): string {
  const raw = vite.define?.['import.meta.env.WAKU_CONFIG_RSC_BASE'];
  if (typeof raw === 'string') {
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value === 'string' && value) return value;
    } catch {
      // fall through
    }
  }
  return 'RSC';
}

/** The directory of a path with a trailing slash removed: Waku's `basePath` (`/` or `/docs/`) as `''` or `/docs`. */
const basePathOf = (base: string): string => (base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`);

/**
 * The Hypdriv plugin for Waku. `withHypDriv()` adds it to `waku.config.ts` together with the Hypdriv adapter; add
 * it by hand next to `unstable_adapter` when you configure Waku yourself:
 *
 * ```ts
 * // waku.config.ts
 * import { hypdriv } from '@hypdriv/waku';
 * import { defineConfig } from 'waku/config';
 * export default defineConfig({
 *   unstable_adapter: '@hypdriv/waku/adapters/node',
 *   vite: { plugins: [hypdriv()] },
 * });
 * ```
 *
 * - Serves `virtual:hypdriv/config` and `virtual:hypdriv/manifest` to Waku's server build (the Hypdriv adapters
 *   import them), and exports the Durable Object classes from the Worker entry on Cloudflare.
 * - After the complete build (Waku's static generation and the platform output included) writes
 *   `.hypdriv/manifest.json` (routes from `src/pages`, CSP hashes of the prerendered pages, Early Hints), patches
 *   it into every server output, and writes the platform's static headers: Cloudflare `_headers`, or the Vercel
 *   Build Output routes, clean-URL overrides and Hypdriv's Routing Middleware for the pages the CDN serves.
 */
export function hypdriv(options: HypDrivWakuOptions = {}): Plugin[] {
  let root = process.cwd();
  let vite: ViteResolvedConfig | null = null;
  let finalized = false;
  let target: WakuTarget = options.target ?? 'node';
  const srcDir = () => resolve(root, options.srcDir ?? 'src');

  const framework = (): ManifestFramework => ({
    name: 'waku',
    version: wakuVersion(root),
    bundler: 'vite',
    bundlerVersion: viteVersion,
    adapter: target,
  });
  const routes = (): DiscoveredRoute[] =>
    mergeRoutes(discoverRoutes(root, { srcDir: srcDir() }), options.routes);

  const host = hostPlugin({
    name: 'hypdriv:waku',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework,
    routes,
    noExternal: ['@hypdriv/waku'],
  });
  const api = host.api;

  const entry: Plugin = {
    name: 'hypdriv:waku-entry',
    enforce: 'pre',
    sharedDuringBuild: true,
    configEnvironment(_name, environment) {
      // Server code imports the virtual modules: it is transformed by Vite (and bundled), never loaded as is.
      if (environment.consumer === 'client') return {};
      return { resolve: { noExternal: ['@hypdriv/waku'] } };
    },
    configResolved(resolved) {
      root = resolved.root;
      vite = resolved;
      target = resolveTarget({
        ...(options.target ? { option: options.target } : {}),
        cloudflarePlugin: resolved.plugins.some((p) => p.name.startsWith('vite-plugin-cloudflare')),
      });
    },
    resolveId(id) {
      if (id === VIRTUAL_DURABLE_OBJECTS) return RESOLVED_DURABLE_OBJECTS;
      if (id === VIRTUAL_WORKER_MAIN) return RESOLVED_WORKER_MAIN;
      // `@cloudflare/vite-plugin` loads the wrangler `main` (`./src/waku.server`) in the dev Worker; without a
      // `waku.server.*` file of your own (Waku's managed mode) it is the managed entry plus the Durable Objects.
      if (target === 'cloudflare' && isManagedWorkerMain(id, root, srcDir())) return RESOLVED_WORKER_MAIN;
      return null;
    },
    load(id) {
      if (id === RESOLVED_WORKER_MAIN)
        return [
          "import server from 'virtual:vite-rsc-waku/server-entry';",
          `export * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)};`,
          'export default server;',
          '',
        ].join('\n');
      if (id !== RESOLVED_DURABLE_OBJECTS) return null;
      // Resolved from this package, not the application: `@hypdriv/cloudflare` is the plugin's own dependency.
      let file: string;
      try {
        file = createRequire(import.meta.url).resolve('@hypdriv/waku/durable-objects');
      } catch {
        file = '@hypdriv/waku/durable-objects';
      }
      return `export * from ${JSON.stringify(file)};\n`;
    },
    transform(code, id) {
      if (target !== 'cloudflare' || options.durableObjects === false) return null;
      const environment = (this as { environment?: { name?: string } }).environment;
      if (environment?.name !== 'rsc') return null;
      if (!WAKU_SERVER_ENTRY.test(id.split('?')[0] as string)) return null;
      if (code.includes(VIRTUAL_DURABLE_OBJECTS)) return null;
      return { code: `${code}\nexport * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)};\n`, map: null };
    },
  };

  const finalize = async (builder: ViteBuilder): Promise<void> => {
    if (finalized || !vite) return;
    finalized = true;
    const log = viteLogger(vite);
    const client = builder.environments.client;
    const rsc = builder.environments.rsc;
    if (!client || !rsc)
      throw new Error(
        'hypdriv: the Waku build has no `rsc` environment; @hypdriv/waku/plugin belongs in the Vite plugins of waku.config.ts',
      );
    const loaded = await api.config();
    const clientDir = resolve(root, client.config.build.outDir);
    const serverDir = resolve(root, rsc.config.build.outDir);
    const basePath = basePathOf(vite.base || '/');
    const assetsDir = client.config.build.assetsDir || 'assets';
    const immutablePrefixes = [`${basePath}/${assetsDir}/`];
    const documents = findDocuments(clientDir, { skip: [assetsDir, rscBaseOf(vite)] });
    const discovered = routes();

    const outputDir = join(root, '.vercel', 'output');
    // Prerendered documents are what the platform serves as built: Workers Static Assets and the Vercel CDN answer
    // them; Waku's Node server serves them from inside the wrapped server, so the pipeline decorates them there.
    const result = await finalizeManifest({
      root,
      config: loaded.resolved,
      framework: framework(),
      base: vite.base || '/',
      basePath,
      trailingSlash: false,
      routes: discovered,
      documents,
      clientDir,
      immutablePrefixes,
      documentsServedStatically: target !== 'node',
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
    const patchDirs = new Set<string>([serverDir]);
    if (target === 'cloudflare') {
      writeCloudflareStatic({ assetsDir: clientDir, rules, log });
    } else if (target === 'vercel') {
      if (existsSync(join(outputDir, 'config.json'))) {
        writeVercelStatic({ outputDir, rules, manifestJson: JSON.stringify(result.manifest), log });
        const served = documents.filter((d) =>
          existsSync(join(outputDir, 'static', relative(clientDir, d.file))),
        );
        const mapped = writeVercelOverrides(
          outputDir,
          served.map((d) => ({ relative: relative(clientDir, d.file).split('\\').join('/'), basePath })),
        );
        // The CDN serves the prerendered documents without Waku's function: Hypdriv's Routing Middleware runs the
        // request stages for them. Everything else reaches the function, which runs them itself.
        await addVercelMiddleware({
          root,
          outputDir,
          config: loaded,
          manifest: result.manifest,
          paths:
            options.vercelMiddleware === false
              ? []
              : served.map((d) => posix.join(basePath || '/', d.pathname === '/' ? '' : d.pathname) || '/'),
          log,
        });
        patchDirs.add(join(outputDir, 'functions'));
        log.info(`hypdriv: Vercel Build Output prepared (${mapped} prerendered page(s) at clean URLs)`);
      } else
        log.warn(
          `hypdriv: no Vercel Build Output at ${relative(root, outputDir)}; build with the Vercel target (VERCEL=1 or HYPDRIV_TARGET=vercel) so Waku's Vercel adapter writes it`,
        );
    }
    const patched = patchRuntimeManifest(
      [...patchDirs].filter((d) => existsSync(d)),
      result.manifest,
    );
    if (patched.length)
      log.info(`hypdriv: final manifest patched into ${patched.length} server file(s) for ${target}`);
    else
      log.warn(
        'hypdriv: no server output embeds the Hypdriv manifest, so the pipeline does not run: select the Hypdriv adapter with `withHypDriv()` (unstable_adapter) or import it in src/waku.server.tsx',
      );
  };

  const build: Plugin = {
    name: 'hypdriv:waku-build',
    apply: 'build',
    enforce: 'post',
    sharedDuringBuild: true,
    buildApp: {
      // After Waku's static generation and the platform adapter's output (build enhancers run inside it).
      order: 'post',
      async handler(builder) {
        await finalize(builder);
      },
    },
  };

  return [host, entry, build];
}

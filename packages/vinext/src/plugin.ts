import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { buildFingerprint, renderReport, type StaticDocument } from '@hypdriv/build';
import type { HypDrivConfig, HypManifest, ManifestFramework } from '@hypdriv/core';
import { writeManifest } from '@hypdriv/core/node';
import {
  addVercelMiddleware,
  type DiscoveredRoute,
  finalizeManifest,
  hostPlugin,
  type PrerenderedDocument,
  patchRuntimeManifest,
  readViteManifest,
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
import { cdnAdapterModuleCode, parseCdnAdapterId, VIRTUAL_CDN_ADAPTER } from './cache-config';
import { PRERENDER_TOKEN_DEFINE, PRERENDER_TOKEN_ENV } from './constants';
import { writeVercelStaticPages } from './outputs';
import {
  fileDigest,
  type PrerenderedPage,
  prerenderedPages,
  readPrerenderManifest,
  staticCacheDigests,
} from './prerender';
import { discoverRoutes, findRouterDirs, type RouterDirs } from './routes';

/** Where the build deploys: the platform whose static configuration the plugin writes. */
export type VinextTarget = 'cloudflare' | 'vercel' | 'node';

export interface HypDrivVinextOptions {
  /** The HypDriv config: a file path (default `hypdriv.config.*` in the Vite root) or an inline config. */
  config?: string | HypDrivConfig;
  /** vinext's `appDir` option when you set it (the directory that contains `app/` and `pages/`). */
  appDir?: string;
  /**
   * The deploy target. Default: detected — `cloudflare` with `@cloudflare/vite-plugin`, `vercel` with Nitro's
   * Vercel preset, else `node` (`vinext start`, or Nitro's Node presets).
   */
  target?: VinextTarget;
  /**
   * Install HypDriv's request hook around vinext's App Router request handler (default true). Turn it off only
   * when the app runs HypDriv elsewhere (a `proxy.ts` built with `@hypdriv/vinext/proxy`).
   */
  hook?: boolean;
  /** Vercel: serve vinext's prerendered static pages from the CDN (default true). */
  vercelStaticPages?: boolean;
  /**
   * Run HypDriv's Routing Middleware on Vercel for the prerendered pages its CDN serves without vinext's function
   * (rate limiting, bot shield, maintenance, redirects, geo; default true).
   */
  vercelMiddleware?: boolean;
}

/** vinext's generated App Router request handler module. */
export const VINEXT_RSC_ENTRY = 'virtual:vinext-rsc-entry';
/** The module the plugin puts in its place: vinext's handler wrapped with HypDriv's request hook. */
export const VIRTUAL_HOOK = 'virtual:hypdriv/vinext-hook';
const RESOLVED_HOOK = `\0${VIRTUAL_HOOK}`;

/** Source of the request hook module (development resolves vinext's hot-reloaded handler per request). */
export function hookModuleCode(options: { development: boolean }): string {
  const common = [
    `import config from 'virtual:hypdriv/config';`,
    `import manifest from 'virtual:hypdriv/manifest';`,
    `import { wrapAppHandler } from '@hypdriv/vinext/runtime';`,
    `export * from ${JSON.stringify(VINEXT_RSC_ENTRY)};`,
  ];
  if (options.development)
    return [
      ...common,
      `const load = () => import(${JSON.stringify(VINEXT_RSC_ENTRY)}).then((m) => m.default);`,
      'export default wrapAppHandler(load, { config, manifest }, { load: true });',
      'if (import.meta.hot) import.meta.hot.accept();',
      '',
    ].join('\n');
  return [
    `import handler from ${JSON.stringify(VINEXT_RSC_ENTRY)};`,
    ...common,
    'export default wrapAppHandler(handler, { config, manifest });',
    '',
  ].join('\n');
}

const isRscEntryId = (id: string): boolean => {
  const clean = id.split('?')[0]!.replace(/\\/g, '/');
  return clean === VINEXT_RSC_ENTRY || clean.endsWith(`/${VINEXT_RSC_ENTRY}`);
};

/** The installed vinext version (vinext exports no `package.json`, so it is found through `node_modules`). */
export function vinextVersion(root: string): string {
  for (let dir = root; ; ) {
    const file = join(dir, 'node_modules', 'vinext', 'package.json');
    if (existsSync(file)) {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
      } catch {
        return 'unknown';
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

interface NitroInfo {
  preset: string;
  outputDir: string;
  serverDir: string;
}

/** The base path vinext defines for its client code (`next.config` `basePath`). */
function basePathOf(vite: ViteResolvedConfig): string {
  const raw = vite.define?.['process.env.__NEXT_ROUTER_BASEPATH'];
  if (typeof raw !== 'string') return '';
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'string' ? value.replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** A HypDriv route id per canonical pattern, as the manifest assigns it. */
const pageId = (pathname: string) => `page:${pathname}`;

/**
 * The HypDriv plugin for vinext. Add it after `vinext()` (and after `cloudflare()` / `nitro()` when you use them):
 *
 * ```ts
 * import vinext from 'vinext';
 * import { hypdriv } from '@hypdriv/vinext';
 * export default defineConfig({ plugins: [vinext({ prerender: true }), hypdriv()] });
 * ```
 *
 * - Installs HypDriv's request hook around vinext's App Router request handler on every runtime (`vinext start`,
 *   Cloudflare Workers, Nitro on Vercel and Node, `vite dev`): the Drivetrain owns every response vinext renders
 *   and application code reads the request through `hyp()`.
 * - After the complete build (vinext's prerender and the platform output included) writes
 *   `.hypdriv/manifest.json` (routes from `app/` and `pages/`, CSP hashes of the prerendered pages the platform
 *   serves as built), patches it into every server output, and writes the platform's static headers
 *   (Cloudflare `_headers`, Vercel Build Output routes; on Vercel the prerendered static pages are served from
 *   the CDN).
 * - Makes `@hypdriv/vinext/worker`, `@hypdriv/vinext/proxy` and the hook skip vinext's build-time prerender
 *   requests (a random per-build token in the build's environment, never present at run time).
 */
export function hypdriv(options: HypDrivVinextOptions = {}): Plugin[] {
  let root = process.cwd();
  let dirs: RouterDirs = { appDir: null, pagesDir: null };
  let vite: ViteResolvedConfig | null = null;
  let nitro: NitroInfo | null = null;
  let command: 'build' | 'serve' = 'serve';
  let finalized = false;
  let hookInstalled = false;
  let workerd = false;
  let token: string | null = null;
  const hook = options.hook !== false;

  const framework = (adapter?: string): ManifestFramework => ({
    name: 'vinext',
    version: vinextVersion(root),
    bundler: 'vite',
    bundlerVersion: viteVersion,
    ...(adapter ? { adapter } : {}),
  });

  const routes = (): DiscoveredRoute[] => discoverRoutes(root, dirs);

  const host = hostPlugin({
    name: 'hypdriv:vinext',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework: () => framework(),
    routes,
    noExternal: ['@hypdriv/vinext'],
  });
  const api = host.api;

  const entry: Plugin = {
    name: 'hypdriv:vinext-hook',
    enforce: 'pre',
    sharedDuringBuild: true,
    config(_user, env) {
      if (env.command !== 'build') return {};
      // Bake a random token into the server code and hand it to vinext's prerender servers (same process, or
      // forked children that inherit the environment). A deployed server never has it in its environment.
      token = randomBytes(24).toString('hex');
      process.env[PRERENDER_TOKEN_ENV] = token;
      return {};
    },
    configEnvironment(name, environment) {
      // Server environments only: the token never reaches client bundles.
      if (!token || name === 'client' || environment.consumer === 'client') return {};
      return { define: { [PRERENDER_TOKEN_DEFINE]: JSON.stringify(token) } };
    },
    configResolved(resolved) {
      root = resolved.root;
      command = resolved.command;
      dirs = findRouterDirs(root, options.appDir);
      workerd = resolved.plugins.some((p) => p.name.startsWith('vite-plugin-cloudflare'));
    },
    resolveId: {
      order: 'pre',
      handler(id, importer) {
        // HypDriv's runtime reads `cloudflare:workers` only when it runs in workerd; Node and Nitro builds keep
        // the (never evaluated) dynamic import external instead of failing to resolve it.
        if (id.startsWith('cloudflare:') && !workerd) return { id, external: true };
        if (parseCdnAdapterId(id) && !id.startsWith('\0')) return `\0${id}`;
        if (!hook || !dirs.appDir || importer === RESOLVED_HOOK || !isRscEntryId(id)) return null;
        const consumer = (this as { environment?: { config?: { consumer?: string } } }).environment?.config
          ?.consumer;
        if (consumer && consumer !== 'server') return null;
        hookInstalled = true;
        return RESOLVED_HOOK;
      },
    },
    load(id) {
      if (id === RESOLVED_HOOK) return hookModuleCode({ development: command === 'serve' });
      if (id.startsWith(`\0${VIRTUAL_CDN_ADAPTER}`)) {
        const spec = parseCdnAdapterId(id);
        if (spec) return cdnAdapterModuleCode(spec);
      }
      return null;
    },
  };

  const finalize = async (builder: ViteBuilder): Promise<void> => {
    if (finalized || !vite) return;
    finalized = true;
    const log = viteLogger(vite);
    const loaded = await api.config();
    const clientEnv = builder.environments.client?.config.build.outDir;
    const clientDir = resolve(root, clientEnv ?? join('dist', 'client'));
    // vinext keeps its build metadata and prerendered pages in dist/server whatever the adapter's layout.
    const serverDir = join(root, 'dist', 'server');
    const target: VinextTarget = options.target ?? detectTarget(vite, nitro);
    const deployment =
      target === 'cloudflare' ? 'cloudflare' : target === 'vercel' ? 'vercel' : nitro ? 'nitro' : 'node';
    if (hook && dirs.appDir && !hookInstalled)
      throw new Error(
        `hypdriv: vinext's App Router entry (${VINEXT_RSC_ENTRY}) was never loaded, so HypDriv's request hook is not installed. @hypdriv/vinext supports vinext ^1.4; check that vinext() is in the plugin list.`,
      );

    const basePath = basePathOf(vite);
    const prerender = readPrerenderManifest(serverDir);
    const pages = prerenderedPages(serverDir, prerender, { basePath });
    const trailingSlash = prerender?.trailingSlash === true;

    // Prerendered pages the platform serves byte for byte as built get hash-based CSPs (`static`); the others
    // are cached by vinext at run time (`isr`: the nonce is injected into vinext's cached HTML).
    const staticCache = deployment === 'cloudflare' ? staticCacheDigests(clientDir) : null;
    const servedAsBuilt = (page: PrerenderedPage): boolean => {
      if (deployment === 'node') return true;
      if (deployment === 'cloudflare') {
        const digest = staticCache ? fileDigest(page.file) : null;
        return digest !== null && staticCache!.has(digest);
      }
      if (deployment === 'vercel')
        return options.vercelStaticPages !== false && page.revalidate === false && page.tags.length === 0;
      return false;
    };
    const discovered = routes();
    const byPattern = new Map(discovered.filter((r) => r.kind === 'page').map((r) => [r.pathname, r]));
    const documents: PrerenderedDocument[] = [];
    const cachedAtRuntime = new Set<string>();
    for (const page of pages) {
      const route = byPattern.get(page.pattern);
      const changes = page.revalidate !== false || page.tags.length > 0;
      if (servedAsBuilt(page)) documents.push({ pathname: page.pathname, file: page.file });
      if (!route || route.pathname.includes('[')) continue;
      if (page.revalidate !== false) route.revalidate = page.revalidate;
      route.prerendered = true;
      if (changes || !servedAsBuilt(page)) cachedAtRuntime.add(pageId(route.pathname));
    }
    // Routes with `export const revalidate = N` are cached and regenerated by vinext at run time.
    for (const route of discovered) {
      if (route.kind === 'page' && typeof route.revalidate === 'number' && route.revalidate > 0) {
        route.prerendered = true;
        cachedAtRuntime.add(pageId(route.pathname));
      }
    }

    const viteManifest = readViteManifest(clientDir);
    const sharedEntries = viteManifest
      ? Object.entries(viteManifest)
          .filter(([, chunk]) => chunk.isEntry)
          .map(([key]) => key)
      : [];
    const immutablePrefixes = [`${basePath}/_next/static/`];
    // Only Vercel serves the documents from the platform's static output; elsewhere vinext serves them through the
    // request hook (the in-memory page cache on Node, the static cache via the Worker on Cloudflare).
    const servedStatically: Record<string, unknown> = { documentsServedStatically: deployment === 'vercel' };
    const result = await finalizeManifest({
      ...servedStatically,
      root,
      config: loaded.resolved,
      framework: framework(nitro ? `nitro:${nitro.preset}` : deployment),
      ...(readText(join(serverDir, 'BUILD_ID')) ? { buildId: readText(join(serverDir, 'BUILD_ID'))! } : {}),
      base: `${basePath}/`,
      basePath,
      trailingSlash,
      routes: discovered,
      documents,
      clientDir,
      viteManifest,
      sharedEntries,
      immutablePrefixes,
      internalPages: ['/404', '/500', '/_error', '/_not-found'],
      log,
      write: false,
    });
    if (result.failures.length)
      throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
    const manifest = await settleClassifications(result.manifest, cachedAtRuntime);
    // Static header rules (hash CSPs) only for documents the platform serves as built.
    const staticDocs: StaticDocument[] = result.documents.filter(
      (d) => manifest.routes.find((r) => r.id === d.routeId)?.classification === 'static',
    );
    const { json } = await writeManifest(root, manifest);
    writeFileSync(join(root, '.hypdriv', 'report.md'), renderReport(manifest));
    for (const w of manifest.warnings) log.warn(`hypdriv: ${w}`);
    api.setManifest(manifest);

    const rules = rulesFor({ config: loaded.resolved, manifest, documents: staticDocs, immutablePrefixes });
    const patchDirs = new Set<string>([serverDir, join(root, 'dist', 'standalone', 'dist', 'server')]);
    for (const [name, env] of Object.entries(builder.environments)) {
      if (name === 'client') continue;
      const outDir = env.config.build.outDir;
      if (outDir) patchDirs.add(resolve(root, outDir));
    }
    if (nitro) {
      patchDirs.add(nitro.serverDir);
      patchDirs.add(join(nitro.outputDir, 'functions'));
    }
    if (deployment === 'cloudflare') {
      patchDirs.add(join(root, '.cloudflare', 'output'));
      writeCloudflareStatic({ assetsDir: clientDir, rules, log });
    }
    if (deployment === 'vercel') {
      const outputDir = nitro?.outputDir ?? join(root, '.vercel', 'output');
      patchDirs.add(join(outputDir, 'functions'));
      const servedPages = pages.filter(
        (p) =>
          servedAsBuilt(p) &&
          manifest.routes.some((r) => r.classification === 'static' && r.pathname === p.pattern),
      );
      const copied = writeVercelStaticPages({ outputDir, pages: servedPages });
      writeVercelStatic({ outputDir, rules, manifestJson: JSON.stringify(manifest), log });
      // The CDN serves those pages without vinext's function: HypDriv's Routing Middleware runs the request stages
      // for them. RSC payloads, Server Actions and other methods go to the function, which runs them itself.
      await addVercelMiddleware({
        root,
        outputDir,
        config: loaded,
        manifest,
        paths: options.vercelMiddleware === false ? [] : copied.map((p) => p.pathname),
        missingHeaders: ['rsc', 'next-action'],
        log,
      });
      if (copied.length)
        log.info(
          `hypdriv: ${copied.length} prerendered page(s) served from Vercel's CDN: ${copied.map((p) => p.pathname).join(', ')}`,
        );
    }
    const patched = patchRuntimeManifest(
      [...patchDirs].filter((d) => existsSync(d)),
      manifest,
    );
    if (!patched.length)
      log.warn(
        'hypdriv: no server output embeds the runtime manifest; is the request hook (or worker entry) built?',
      );
    log.info(
      `hypdriv: manifest written (${manifest.routes.length} routes, ${staticDocs.length} served as built) → ${relative(root, json)}; final manifest patched into ${patched.length} server file(s) for ${deployment}`,
    );
  };

  const build: Plugin & { nitro?: unknown } = {
    name: 'hypdriv:vinext-build',
    apply: 'build',
    enforce: 'post',
    sharedDuringBuild: true,
    // Nitro's plugin extension: learn the preset and the output directories.
    nitro: {
      setup(instance: { options: { preset?: string; output?: { dir?: string; serverDir?: string } } }) {
        const output = instance.options.output ?? {};
        nitro = {
          preset: instance.options.preset ?? 'node-server',
          outputDir: resolve(root, output.dir ?? '.output'),
          serverDir: resolve(root, output.serverDir ?? join(output.dir ?? '.output', 'server')),
        };
      },
    },
    configResolved: {
      order: 'post',
      handler(resolved) {
        vite = resolved;
        // vinext moves its build finaliser (prerender, cache packaging, standalone output) to the end of the
        // plugin list in its own configResolved; follow it so `buildApp` runs after the complete build.
        const plugins = resolved.plugins as Plugin[];
        const index = plugins.indexOf(build);
        if (index !== -1 && index !== plugins.length - 1) plugins.push(...plugins.splice(index, 1));
      },
    },
    buildApp: {
      order: 'post',
      async handler(builder) {
        await finalize(builder);
      },
    },
  };

  return [host, entry, build];
}

/** Routes vinext caches and regenerates at run time are `isr` (nonce CSP, no build-time hashes). */
async function settleClassifications(manifest: HypManifest, isr: Set<string>): Promise<HypManifest> {
  let changed = false;
  for (const route of manifest.routes) {
    if (!isr.has(route.id) || route.classification === 'isr') continue;
    if (route.classification !== 'static' && route.classification !== 'dynamic') continue;
    route.classification = 'isr';
    changed = true;
  }
  if (!changed) return manifest;
  for (const key of Object.keys(manifest.csp)) {
    const id = key.split('#')[0]!;
    if (manifest.routes.find((r) => r.id === id)?.classification === 'isr') delete manifest.csp[key];
  }
  manifest.fingerprint = await buildFingerprint(manifest);
  return manifest;
}

function detectTarget(vite: ViteResolvedConfig, nitro: NitroInfo | null): VinextTarget {
  if (vite.plugins.some((p) => p.name.startsWith('vite-plugin-cloudflare'))) return 'cloudflare';
  if (nitro?.preset.startsWith('vercel')) return 'vercel';
  return 'node';
}

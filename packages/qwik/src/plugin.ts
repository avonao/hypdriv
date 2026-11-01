import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative, resolve } from 'node:path';
import type { HypDrivConfig, HypManifest, ManifestFramework } from '@hypdriv/core';
import { createHandler, type HypHandler } from '@hypdriv/runtime';
import {
  addVercelMiddleware,
  type DiscoveredRoute,
  developmentManifest,
  ensureAssetsIgnore,
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
import { devMiddleware } from './dev';
import { findDocuments } from './documents';
import { WORKER_FILES } from './output/cloudflare';
import { discoverRoutes, mergeRoutes, promotePrerendered, type QwikBuiltRoute } from './routes';
import { isAdapterPlugin, type QwikTarget, resolveTarget } from './target';

export interface HypDrivQwikOptions {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * The deploy target. Default: the adapter that builds the server (`adapters/<target>/vite.config.ts`), else
   * `HYPDRIV_TARGET`, `vercel` when building on Vercel (`VERCEL=1`), `cloudflare` when `CLOUDFLARE` or `WORKERS_CI`
   * is set, else `node`.
   */
  target?: QwikTarget;
  /**
   * Routes the plugin cannot read from Qwik Router's route table (rewritten or programmatic routes): added to
   * them, or a function that returns the final list.
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
  /** Run the pipeline around Qwik's dev server (`vite --mode ssr`, default true). */
  dev?: boolean;
}

/** The module the plugin appends to the Cloudflare server entry: the Durable Object classes. */
export const VIRTUAL_DURABLE_OBJECTS = 'virtual:hypdriv/durable-objects';
const RESOLVED_DURABLE_OBJECTS = `\0${VIRTUAL_DURABLE_OBJECTS}`;

/** The Vite plugins of Qwik Router and Qwik that the Hypdriv plugin reads from. */
const ROUTER_PLUGIN = 'vite-plugin-qwik-router';
const QWIK_PLUGIN = 'vite-plugin-qwik';

interface RouterApi {
  getRoutes(): QwikBuiltRoute[];
  getBasePathname(): string;
}

interface QwikApi {
  getClientOutDir(): string | null;
  getClientPublicOutDir(): string | null;
}

/** The installed Qwik version (`@qwik.dev/core/package.json`), or `unknown`. */
export function qwikVersion(root: string): string {
  try {
    const file = createRequire(join(root, 'package.json')).resolve('@qwik.dev/core/package.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    try {
      const file = createRequire(join(root, 'package.json')).resolve('@qwik.dev/router/package.json');
      return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/** The directory of a base pathname without its trailing slash: Qwik's `basePathname` (`/` or `/docs/`) as `''` or `/docs`. */
export const basePathOf = (basePathname: string): string =>
  basePathname === '/' ? '' : `/${basePathname.replace(/^\/+|\/+$/g, '')}`;

/** Strips the base path from route patterns (Qwik's route names include it; Hypdriv's `basePath` is separate). */
export function stripBase(routes: DiscoveredRoute[], basePath: string): DiscoveredRoute[] {
  if (!basePath) return routes;
  return routes.map((route) =>
    route.pathname === basePath || route.pathname.startsWith(`${basePath}/`)
      ? { ...route, pathname: route.pathname.slice(basePath.length) || '/' }
      : route,
  );
}

/** The input files of a server build (`build.rolldownOptions.input`), as absolute paths. */
export function buildInputs(vite: Pick<ViteResolvedConfig, 'root' | 'build'>): string[] {
  const input = (vite.build as { rolldownOptions?: { input?: unknown } }).rolldownOptions?.input;
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? [input]
      : input && typeof input === 'object'
        ? Object.values(input)
        : [];
  return values.filter((v): v is string => typeof v === 'string').map((v) => resolve(vite.root, v));
}

function readManifest(root: string): HypManifest | null {
  const file = join(root, '.hypdriv', 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HypManifest;
  } catch {
    return null;
  }
}

/**
 * The Hypdriv plugin for Qwik Router. Add it to the base `vite.config.ts` next to `qwikRouter()` and `qwikVite()`:
 *
 * ```ts
 * // vite.config.ts
 * import { hypdriv } from '@hypdriv/qwik';
 * import { qwikVite } from '@qwik.dev/core/optimizer';
 * import { qwikRouter } from '@qwik.dev/router/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({ plugins: [qwikRouter(), qwikVite(), hypdriv()] });
 * ```
 *
 * - Serves `virtual:hypdriv/config` and `virtual:hypdriv/manifest` to the server build (the Hypdriv middleware
 *   imports them), and exports the Durable Object classes from the Worker entry on Cloudflare.
 * - After the server build (Qwik's static generation and the platform adapter's output included) writes
 *   `.hypdriv/manifest.json` (routes from Qwik Router's route table, CSP hashes of the prerendered pages, Early
 *   Hints), patches it into every server output, and writes the platform's static headers: Cloudflare `_headers`,
 *   or the Vercel Build Output routes and Hypdriv's Routing Middleware for the pages the CDN serves.
 * - In `vite --mode ssr` runs the pipeline around Qwik's dev SSR (security headers, nonce CSP, `/_hypdriv/*`).
 */
export function hypdriv(options: HypDrivQwikOptions = {}): Plugin[] {
  let root = process.cwd();
  let vite: ViteResolvedConfig | null = null;
  let finalized = false;
  let adapter: string | undefined;
  let target: QwikTarget = options.target ?? 'node';
  let routerApi: RouterApi | undefined;
  let qwikApi: QwikApi | undefined;
  let entryFiles: string[] = [];

  const basePathname = (): string => routerApi?.getBasePathname() ?? '/';
  const framework = (): ManifestFramework => ({
    name: 'qwik',
    version: qwikVersion(root),
    bundler: 'vite',
    bundlerVersion: viteVersion,
    adapter: target,
  });
  const routes = (): DiscoveredRoute[] => {
    const built = routerApi?.getRoutes() ?? [];
    return mergeRoutes(
      stripBase(discoverRoutes(built, { root }), basePathOf(basePathname())),
      options.routes,
    );
  };

  const host = hostPlugin({
    name: 'hypdriv:qwik',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework,
    routes,
    noExternal: ['@hypdriv/qwik'],
  });
  const api = host.api;

  const entry: Plugin = {
    name: 'hypdriv:qwik-entry',
    enforce: 'pre',
    sharedDuringBuild: true,
    configEnvironment(_name, environment) {
      // Server code imports the virtual modules and the Hypdriv packages: bundled by Vite, never loaded as is
      // (the deployed server has only the bundle, and pnpm does not link Hypdriv's internal packages for the app).
      if (environment.consumer === 'client') return {};
      return { resolve: { noExternal: [/^@hypdriv\//] } };
    },
    configResolved(resolved) {
      root = resolved.root;
      vite = resolved;
      adapter = resolved.plugins.find((p) => isAdapterPlugin(p.name))?.name;
      target = resolveTarget({
        ...(options.target ? { option: options.target } : {}),
        ...(adapter ? { adapter } : {}),
      });
      routerApi = (resolved.plugins.find((p) => p.name === ROUTER_PLUGIN) as { api?: RouterApi } | undefined)
        ?.api;
      qwikApi = (resolved.plugins.find((p) => p.name === QWIK_PLUGIN) as { api?: QwikApi } | undefined)?.api;
      entryFiles = buildInputs(resolved);
      // A server build without a platform adapter is the preview build (`vite build --ssr src/entry.preview.tsx`):
      // it embeds the manifest of the last platform build, whose static files `vite preview` serves.
      if (!adapter && resolved.command === 'build') {
        const built = readManifest(root);
        if (built) api.setManifest(built);
      }
    },
    resolveId(id) {
      return id === VIRTUAL_DURABLE_OBJECTS ? RESOLVED_DURABLE_OBJECTS : null;
    },
    load(id) {
      if (id !== RESOLVED_DURABLE_OBJECTS) return null;
      // Resolved from this package, not the application: `@hypdriv/cloudflare` is the plugin's own dependency.
      let file: string;
      try {
        file = createRequire(import.meta.url).resolve('@hypdriv/qwik/durable-objects');
      } catch {
        file = '@hypdriv/qwik/durable-objects';
      }
      return `export * from ${JSON.stringify(file)};\n`;
    },
    transform(code, id) {
      if (target !== 'cloudflare' || options.durableObjects === false) return null;
      const environment = (
        this as {
          environment?: {
            config?: { consumer?: string; build?: Pick<ViteResolvedConfig, 'build'>['build'] };
          };
        }
      ).environment;
      if (environment?.config?.consumer === 'client') return null;
      // The server build's inputs live in its environment's options (the adapter's `build.rolldownOptions.input`).
      const inputs = [
        ...entryFiles,
        ...(environment?.config?.build ? buildInputs({ root, build: environment.config.build }) : []),
      ];
      if (!inputs.includes(id.split('?')[0] as string)) return null;
      if (code.includes(VIRTUAL_DURABLE_OBJECTS)) return null;
      return { code: `${code}\nexport * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)};\n`, map: null };
    },
  };

  const finalize = async (builder: ViteBuilder): Promise<void> => {
    // The client build has no adapter: the manifest is written once the server build and static generation ran.
    if (finalized || !vite || !adapter) return;
    finalized = true;
    const log = viteLogger(vite);
    if (!routerApi)
      throw new Error(
        "hypdriv: @hypdriv/qwik needs Qwik Router's Vite plugin (`qwikRouter()` from @qwik.dev/router/vite) in vite.config.ts",
      );
    const loaded = await api.config();
    const base = basePathname();
    const basePath = basePathOf(base);
    const clientDir = resolve(root, qwikApi?.getClientPublicOutDir() ?? 'dist');
    const serverEnvironment =
      builder.environments.ssr ??
      Object.values(builder.environments).find((e) => e.config.consumer === 'server');
    const serverDir = resolve(root, serverEnvironment?.config.build.outDir ?? 'server');
    const noTrailingSlash = vite.define?.['globalThis.__NO_TRAILING_SLASH__'] === 'true';
    const immutablePrefixes = [`${base}build/`, `${base}assets/`];
    const documents = findDocuments(clientDir, { skip: ['build', 'assets'] });
    const outputDir = join(root, '.vercel', 'output');

    // Prerendered documents are files served as built: Workers Static Assets, the Vercel CDN and the Node server's
    // static handler answer them (the pipeline decorates the response on every platform), so their routes are the
    // static layer's and get hash policies. A dynamic route's prerendered paths (`onStaticGenerate`) are routes of
    // their own for that reason; the route keeps the paths that render per request.
    const result = await finalizeManifest({
      root,
      config: loaded.resolved,
      framework: framework(),
      base,
      basePath,
      trailingSlash: !noTrailingSlash,
      routes: promotePrerendered(
        routes(),
        documents.map((d) => d.pathname),
      ),
      documents,
      clientDir,
      immutablePrefixes,
      documentsServedStatically: true,
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
      ensureAssetsIgnore(clientDir, WORKER_FILES);
    } else if (target === 'vercel') {
      if (existsSync(join(outputDir, 'config.json'))) {
        writeVercelStatic({ outputDir, rules, manifestJson: JSON.stringify(result.manifest), log });
        const served = documents.filter((d) =>
          existsSync(
            join(outputDir, 'static', ...base.split('/').filter(Boolean), relative(clientDir, d.file)),
          ),
        );
        // The CDN serves the prerendered documents without the function: Hypdriv's Routing Middleware runs the
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
        log.info(`hypdriv: Vercel Build Output prepared (${served.length} prerendered page(s) from the CDN)`);
      } else
        log.warn(
          `hypdriv: no Vercel Build Output at ${relative(root, outputDir)}; build with the Hypdriv Vercel adapter (adapters/vercel/vite.config.ts) so the function and static files are written`,
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
        `hypdriv: no server output embeds the Hypdriv manifest, so the pipeline does not run: import createQwikRouter from '@hypdriv/qwik/middleware/${target}' in src/entry.${target}.tsx`,
      );
  };

  const build: Plugin = {
    name: 'hypdriv:qwik-build',
    apply: 'build',
    enforce: 'post',
    sharedDuringBuild: true,
    buildApp: {
      // After Qwik's static generation and the platform adapter's output (its own buildApp hook runs first).
      order: 'post',
      async handler(builder) {
        await finalize(builder);
      },
    },
  };

  const devHandler = (() => {
    let handler: HypHandler | null = null;
    let signature = '';
    return async (): Promise<HypHandler> => {
      const list = routes();
      const next = list.map((r) => `${r.kind}:${r.pathname}`).join('|');
      // The route table changes while developing: the handler follows it.
      if (handler && next === signature) return handler;
      signature = next;
      const loaded = await api.config();
      handler = createHandler({
        config: loaded.resolved,
        manifest: api.manifest() ?? developmentManifest(framework(), list),
        host: 'qwik',
        target: 'node',
        development: true,
      });
      return handler;
    };
  })();

  const serve: Plugin = {
    name: 'hypdriv:qwik-serve',
    enforce: 'pre',
    configureServer(server) {
      if (options.dev === false) return;
      // Registered directly, not in a post hook: Qwik Router's dev SSR middleware is a post hook, and its plugin sits
      // before this one in the application's plugin list, so a post hook of ours would run after it. Vite's own
      // requests (modules, HMR, assets) are passed on untouched (`wantsRequest`); everything else, including what
      // Qwik renders, is the pipeline's.
      server.middlewares.use(devMiddleware({ handler: devHandler }));
    },
    configurePreviewServer() {
      // `vite preview` runs the application's `src/entry.preview.tsx`, which imports the manifest module: serve the
      // manifest the build wrote.
      const manifest = readManifest(root);
      if (manifest) api.setManifest(manifest);
    },
  };

  return [host, entry, build, serve];
}

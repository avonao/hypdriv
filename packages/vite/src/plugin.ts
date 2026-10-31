import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { HypDrivConfig, HypManifest, Logger } from '@hypdriv/core';
import { createHandler, type HypHandler } from '@hypdriv/runtime';
import { type Plugin, type ViteBuilder, type ResolvedConfig as ViteResolvedConfig, version } from 'vite';
import { connectMiddleware, isViteInternal } from './dev';
import { finalizeManifest, type PrerenderedDocument } from './finalize';
import { hostPlugin, patchRuntimeManifest } from './host';
import { createStaticHandler, isNavigation } from './node/index';
import type { DiscoveredRoute } from './routes';
import { rulesFor, writeCloudflareStatic } from './targets';
import { writeVercelOutput } from './vercel-output';

/** Deployment targets the plugin writes static configuration for. */
export type ViteTarget = 'cloudflare' | 'vercel' | 'node';

export interface HypDrivPluginOptions {
  /** The HypDriv config: a file path (default `hypdriv.config.*` in the Vite root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * Single-page app: unknown navigations serve `index.html` (and get its CSP). Default: Vite's `appType` is
   * `spa` and the build has one HTML entry.
   */
  spa?: boolean;
  /**
   * Targets to write static configuration for (Cloudflare `_headers`, Vercel Build Output). Default: detected —
   * `cloudflare` when `@cloudflare/vite-plugin` built the app, `vercel` when building on Vercel (`VERCEL=1`).
   */
  targets?: ViteTarget[];
  /** Vercel: build HypDriv's Routing Middleware so the request stages run before the CDN (default true). */
  vercelMiddleware?: boolean;
  /** Run the pipeline around HTML documents in `vite dev` and `vite preview` (default true). */
  dev?: boolean;
}

interface HtmlAsset {
  fileName: string;
  source: string;
}

/** `index.html` → `/`, `about.html` → `/about`, `docs/index.html` → `/docs`. */
export function htmlPathname(fileName: string): string {
  const clean = fileName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean === 'index.html') return '/';
  if (clean.endsWith('/index.html')) return `/${clean.slice(0, -'/index.html'.length)}`;
  return `/${clean.replace(/\.html$/, '')}`;
}

/**
 * The HypDriv plugin for plain Vite apps (single- and multi-page). After `vite build` it writes
 * `.hypdriv/manifest.json` (pages, assets, CSP hashes of the built HTML, Early Hints), the static headers of the
 * detected platform (Cloudflare `_headers`, Vercel Build Output with HypDriv's Routing Middleware) and patches
 * the manifest into a Cloudflare Worker built alongside; in `vite dev` / `vite preview` it runs the pipeline around
 * HTML documents.
 *
 * ```ts
 * // vite.config.ts
 * import { hypdriv } from '@hypdriv/vite';
 * export default defineConfig({ plugins: [hypdriv()] });
 * ```
 */
export function hypdriv(options: HypDrivPluginOptions = {}): Plugin[] {
  const html = new Map<string, HtmlAsset>();
  let vite: ViteResolvedConfig | null = null;
  let finalized = false;
  const routes = (): DiscoveredRoute[] => {
    const pages = [...html.values()].map((a) => htmlPathname(a.fileName));
    const list: DiscoveredRoute[] = (pages.length ? pages : ['/']).map((pathname) => ({
      pathname,
      kind: 'page' as const,
      prerendered: true,
    }));
    if (isSpa()) list.push({ pathname: '/[...path]', kind: 'page', prerendered: true, fallback: true });
    return list;
  };
  // One HTML entry is a single-page app unless Vite is told it is a multi-page app.
  const isSpa = () => options.spa ?? (vite?.appType !== 'mpa' && html.size <= 1);
  const host = hostPlugin({
    name: 'hypdriv:vite',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework: () => ({
      name: 'vite',
      version: viteVersion(),
      bundler: 'vite',
      bundlerVersion: viteVersion(),
    }),
    routes,
  });
  const api = host.api;

  const clientOutDir = (): string => {
    const env = vite?.environments?.client?.build?.outDir ?? vite?.build.outDir ?? 'dist';
    return resolve(vite?.root ?? process.cwd(), env);
  };

  const finalize = async (builder?: ViteBuilder): Promise<void> => {
    if (finalized || !vite) return;
    finalized = true;
    const root = vite.root;
    const loaded = await api.config();
    const outDir = clientOutDir();
    const documents: PrerenderedDocument[] = [...html.values()].map((a) => ({
      pathname: htmlPathname(a.fileName),
      file: join(outDir, a.fileName),
    }));
    const spa = isSpa();
    const shell = documents.find((d) => d.pathname === '/');
    const base = vite.base || '/';
    const assetsDir = vite.build.assetsDir || 'assets';
    const immutablePrefixes = [`${base.replace(/\/$/, '')}/${assetsDir}/`];
    const result = await finalizeManifest({
      root,
      config: loaded.resolved,
      framework: { name: 'vite', version: viteVersion(), bundler: 'vite', bundlerVersion: viteVersion() },
      base,
      routes: routes(),
      documents: documents.filter((d) => d.pathname !== '/[...path]'),
      // The catch-all page of a single-page app is served by the shell document.
      ...(spa && shell ? { documentAliases: { '/[...path]': '/' } } : {}),
      clientDir: outDir,
      immutablePrefixes,
      log: viteLogger(vite),
    });
    if (result.failures.length)
      throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
    api.setManifest(result.manifest);
    const staticDocs = result.documents.filter((d) => d.pathname !== '/[...path]');
    const shellDoc = spa ? staticDocs.find((d) => d.pathname === '/') : undefined;
    const rules = rulesFor({
      config: loaded.resolved,
      manifest: result.manifest,
      documents: staticDocs,
      immutablePrefixes,
      ...(shellDoc ? { spaShell: shellDoc } : {}),
    });
    const targets = new Set(options.targets ?? detectTargets(vite, builder));
    const log = viteLogger(vite);
    if (targets.has('cloudflare')) {
      writeCloudflareStatic({ assetsDir: outDir, rules, log });
      // A Worker built next to the client (run_worker_first) embeds the runtime manifest: patch in the final one.
      const workerDirs = serverOutDirs(vite, builder);
      const patched = patchRuntimeManifest(workerDirs, result.manifest);
      if (patched.length) log.info(`hypdriv: final manifest patched into ${patched.length} Worker file(s)`);
    }
    if (targets.has('vercel')) {
      await writeVercelOutput({
        root,
        clientDir: outDir,
        rules,
        manifest: result.manifest,
        config: loaded,
        spa,
        documents: staticDocs,
        middleware: options.vercelMiddleware !== false,
        log,
      });
    }
  };

  const devHandler = (() => {
    let handler: HypHandler | null = null;
    return async () => {
      if (handler) return handler;
      const loaded = await api.config();
      handler = createHandler({
        config: loaded.resolved,
        manifest: api.manifest() ?? readManifest(api.root),
        host: 'vite',
        target: 'node',
      });
      return handler;
    };
  })();

  const build: Plugin = {
    name: 'hypdriv:vite-build',
    enforce: 'post',
    sharedDuringBuild: true,
    configResolved(resolved) {
      vite = resolved;
    },
    generateBundle: {
      order: 'post',
      handler(_output, bundle) {
        const env = (this as { environment?: { name?: string; config?: { consumer?: string } } }).environment;
        if (env?.config?.consumer && env.config.consumer !== 'client') return;
        for (const [fileName, out] of Object.entries(bundle)) {
          if (out.type === 'asset' && fileName.endsWith('.html'))
            html.set(fileName, { fileName, source: String(out.source) });
        }
      },
    },
    buildApp: {
      order: 'post',
      async handler(builder) {
        // In a plain Vite build every buildApp hook runs before anything is built (the CLI builds the client
        // afterwards as a fallback): build it here so the manifest sees the output. Integrations such as
        // @cloudflare/vite-plugin have built their environments by now.
        const client = builder.environments.client;
        if (client && !client.isBuilt) await builder.build(client);
        await finalize(builder);
      },
    },
    async closeBundle() {
      // Programmatic `build()` never calls buildApp: finalise after the client bundle was written.
      const env = (this as { environment?: { name?: string } }).environment;
      if (env && env.name !== 'client') return;
      if (process.env.HYPDRIV_VITE_BUILDAPP === '1') return;
      await finalize();
    },
  };

  const serve: Plugin = {
    name: 'hypdriv:vite-serve',
    configureServer(server) {
      if (options.dev === false) return;
      return () => {
        server.middlewares.use(
          connectMiddleware({
            handler: lazyHandler(devHandler),
            wants: (url, request) => !isViteInternal(url.pathname) && isNavigation(request),
            async render(request) {
              const url = new URL(request.url);
              const file = htmlFileFor(server.config.root, url.pathname, isSpa());
              if (!file) return null;
              const raw = readFileSync(file, 'utf8');
              let out = await server.transformIndexHtml(url.pathname, raw, url.pathname);
              // Vite's client injects CSS as <style> elements and reads their nonce from this meta tag.
              const nonce = request.headers.get('x-nonce');
              if (nonce)
                out = out.replace(/<head([^>]*)>/i, `<head$1><meta property="csp-nonce" nonce="${nonce}">`);
              return new Response(out, { headers: { 'content-type': 'text/html; charset=utf-8' } });
            },
          }),
        );
      };
    },
    configurePreviewServer(server) {
      if (options.dev === false) return;
      const outDir = resolve(server.config.root, server.config.build.outDir);
      const manifest = readManifest(server.config.root);
      const serveStatic = createStaticHandler({
        dir: outDir,
        immutablePrefixes: manifest?.staticFiles.immutablePrefixes ?? ['/assets/'],
        spaFallback: manifest?.routes.some((r) => r.pathname === '/[...path]') ? 'index.html' : null,
      });
      server.middlewares.use(
        connectMiddleware({
          handler: lazyHandler(devHandler),
          render: (request) => serveStatic(request),
        }),
      );
    },
  };

  return [host, build, serve];
}

function lazyHandler(get: () => Promise<HypHandler>): HypHandler {
  const fn = (async (request, input) => (await get())(request, input)) as HypHandler;
  return fn;
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

/** The source HTML file a dev request renders (`/about` → `about.html`), or the SPA shell. */
function htmlFileFor(root: string, pathname: string, spa: boolean): string | null {
  const clean = decodeURIComponent(pathname).replace(/\/+$/, '');
  const candidates = clean
    ? [join(root, `${clean}.html`), join(root, clean, 'index.html'), join(root, clean)]
    : [join(root, 'index.html')];
  for (const file of candidates) {
    if (!relative(root, file).startsWith('..') && file.endsWith('.html') && existsSync(file)) return file;
  }
  return spa && existsSync(join(root, 'index.html')) ? join(root, 'index.html') : null;
}

function viteVersion(): string {
  return typeof version === 'string' ? version : 'unknown';
}

/** Output directories of non-client environments (Workers built by `@cloudflare/vite-plugin`). */
function serverOutDirs(vite: ViteResolvedConfig, builder?: ViteBuilder): string[] {
  const dirs = new Set<string>();
  const envs = builder?.environments ?? {};
  for (const [name, env] of Object.entries(envs)) {
    if (name === 'client') continue;
    const outDir = (env as { config?: { build?: { outDir?: string } } }).config?.build?.outDir;
    if (outDir) dirs.add(resolve(vite.root, outDir));
  }
  for (const [name, env] of Object.entries(vite.environments ?? {})) {
    if (name === 'client') continue;
    if (env.build?.outDir) dirs.add(resolve(vite.root, env.build.outDir));
  }
  return [...dirs].filter((d) => existsSync(d));
}

function detectTargets(vite: ViteResolvedConfig, builder?: ViteBuilder): ViteTarget[] {
  const out: ViteTarget[] = [];
  const cloudflare =
    vite.plugins.some((p) => p.name.startsWith('vite-plugin-cloudflare')) ||
    existsSync(join(vite.root, '.wrangler', 'deploy', 'config.json')) ||
    serverOutDirs(vite, builder).some((d) => existsSync(join(d, 'wrangler.json')));
  if (cloudflare) out.push('cloudflare');
  if (process.env.VERCEL === '1' || process.env.HYPDRIV_TARGET === 'vercel') out.push('vercel');
  if (!out.length) out.push('node');
  return out;
}

/** A HypDriv logger that prints through Vite's logger. */
export function viteLogger(vite: Pick<ViteResolvedConfig, 'logger'>): Logger {
  const logger: Logger = {
    level: 'info',
    debug: () => undefined,
    info: (m) => vite.logger.info(m),
    warn: (m) => vite.logger.warn(m),
    error: (m) => vite.logger.error(m),
    child: () => logger,
  };
  return logger;
}

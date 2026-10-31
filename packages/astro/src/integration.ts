import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteAssetSources } from '@hypdriv/build';
import { type HypDrivConfig, type Logger, loadConfig, type ManifestFramework } from '@hypdriv/core';
import { hostPlugin, type LoadedHypConfig, loadHypConfig, VIRTUAL_MANIFEST } from '@hypdriv/vite';
import type { AstroConfig, AstroIntegration, AstroIntegrationLogger } from 'astro';
import { version as viteVersion } from 'vite';
import { finalizeAstroBuild, type GeneratedFile } from './build';
import {
  type AstroManifestRouteLike,
  type AstroRouteLike,
  fromAstroRoutes,
  sourcesFromSsrManifest,
} from './routes';
import { type AstroBuildFacts, type AstroTarget, astroVitePlugin } from './vite';

export interface HypDrivAstroOptions {
  /** The HypDriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * Platforms whose static configuration the build writes (Cloudflare `_headers`, Vercel Build Output routes,
   * `@astrojs/node`'s `_headers.json`). Default: the platform of the Astro adapter.
   */
  targets?: AstroTarget[];
  /**
   * Inject the on-demand route `/_hypdriv/[...path]` so HypDriv's internal routes (`/_hypdriv/health`, CSP reports,
   * Web Vitals, DevTools) reach the middleware in production, where Astro answers unmatched paths without it.
   * Default true when an adapter is configured.
   */
  internalRoutes?: boolean;
  vercel?: {
    /**
     * Run HypDriv's Routing Middleware for prerendered pages, which Vercel's CDN serves without Astro's function
     * (rate limiting, bot shield, maintenance, redirects, geo; default true).
     */
    middleware?: boolean;
  };
}

/** The platform an Astro adapter deploys to. */
export function adapterTarget(name: string | undefined): AstroTarget | null {
  if (!name) return null;
  if (name === '@astrojs/cloudflare') return 'cloudflare';
  if (name === '@astrojs/vercel' || name.startsWith('@astrojs/vercel/')) return 'vercel';
  if (name === '@astrojs/node') return 'node';
  return null;
}

/** Wraps Astro's integration logger as a HypDriv logger. */
export function astroLogger(
  logger: Pick<AstroIntegrationLogger, 'info' | 'warn' | 'error' | 'debug'>,
): Logger {
  const out: Logger = {
    level: 'info',
    debug: (message) => logger.debug(message),
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
    child: () => out,
  };
  return out;
}

function astroVersion(root: string): string {
  try {
    const require = createRequire(join(root, 'package.json'));
    return (require('astro/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** The config the build finalises with: Astro's `security.csp` owns the policy, so HypDriv's CSP is off. */
export function effectiveConfig(loaded: LoadedHypConfig, astroCsp: boolean) {
  if (!astroCsp || !loaded.resolved.security.csp) return loaded.resolved;
  return loadConfig({ ...loaded.raw, security: { ...(loaded.raw.security ?? {}), csp: false } });
}

interface DevServerLike {
  environments?: Record<
    string,
    { moduleGraph?: { getModuleById(id: string): unknown; invalidateModule(mod: never): void } }
  >;
}

/**
 * The HypDriv integration for Astro 7. Runs the HypDriv Drivetrain around Astro's middleware on every route Astro
 * renders on demand, writes the route manifest (routes, classifications, CSP hashes of prerendered pages, Early
 * Hints) and the static header rules of the adapter's platform after the build, and patches the final manifest into
 * the server output.
 *
 * ```js
 * // astro.config.mjs
 * import cloudflare from '@astrojs/cloudflare';
 * import hypdriv from '@hypdriv/astro';
 * export default defineConfig({ adapter: cloudflare(), integrations: [hypdriv()] });
 * ```
 */
export function hypdriv(options: HypDrivAstroOptions = {}): AstroIntegration {
  let root = process.cwd();
  let astroConfig: AstroConfig | null = null;
  let loaded: LoadedHypConfig | null = null;
  let internalPrefix = '/_hypdriv';
  let resolvedRoutes: AstroRouteLike[] = [];
  let sources = new Map<string, RouteAssetSources>();
  let nodeStaticHeaders = false;
  let target: AstroTarget | null = null;
  let devServer: DevServerLike | null = null;
  const facts: AstroBuildFacts = { development: false, target: null, astroCsp: false };
  let host: ReturnType<typeof hostPlugin> | null = null;

  const framework = (): ManifestFramework => ({
    name: 'astro',
    version: astroVersion(root),
    bundler: 'vite',
    bundlerVersion: viteVersion,
    ...(target ? { adapter: target } : {}),
  });
  const routes = () => fromAstroRoutes(resolvedRoutes, { internalPrefix, sources });

  return {
    name: '@hypdriv/astro',
    hooks: {
      'astro:config:setup': async ({ config, command, updateConfig, addMiddleware, injectRoute, logger }) => {
        root = fileURLToPath(config.root);
        loaded = await loadHypConfig(root, options.config);
        internalPrefix = loaded.resolved.cloudflare.internalPathPrefix.replace(/\/+$/, '') || '/_hypdriv';
        const adapterName = (config.adapter as { name?: string } | undefined)?.name;
        target = adapterTarget(adapterName);
        facts.development = command === 'dev';
        facts.target = command === 'build' ? target : null;
        facts.astroCsp = !!config.security?.csp;
        if (facts.astroCsp && loaded.resolved.security.csp)
          logger.info(
            "Astro's security.csp is enabled: Astro owns the Content-Security-Policy and HypDriv's CSP is off. Remove security.csp from the Astro config to use HypDriv's nonce and hash policy.",
          );
        if (adapterName && !target && !options.targets)
          logger.warn(
            `HypDriv writes static headers for Cloudflare, Vercel and Node; the ${adapterName} adapter gets the manifest and the middleware only (set the integration's \`targets\` option to write one of those).`,
          );
        host = hostPlugin({
          name: 'hypdriv:astro-host',
          ...(options.config !== undefined ? { config: options.config } : {}),
          framework,
          routes,
          noExternal: ['@hypdriv/astro'],
        });
        updateConfig({ vite: { plugins: [astroVitePlugin({ facts: () => facts, host: host.api }), host] } });
        addMiddleware({ entrypoint: '@hypdriv/astro/middleware', order: 'pre' });
        if (options.internalRoutes ?? !!config.adapter)
          injectRoute({
            pattern: `${internalPrefix}/[...path]`,
            entrypoint: '@hypdriv/astro/internal-route',
            prerender: false,
          });
      },
      'astro:config:done': ({ config }) => {
        astroConfig = config;
      },
      'astro:server:setup': ({ server }) => {
        devServer = server as unknown as DevServerLike;
      },
      'astro:routes:resolved': ({ routes: list }) => {
        resolvedRoutes = list as unknown as AstroRouteLike[];
        // `astro dev`: the development manifest lists the routes; serve the new list on the next import.
        for (const env of Object.values(devServer?.environments ?? {})) {
          const graph = env.moduleGraph;
          const mod = graph?.getModuleById(`\0${VIRTUAL_MANIFEST}`);
          if (graph && mod) graph.invalidateModule(mod as never);
        }
      },
      'astro:build:ssr': ({ manifest }) => {
        const list = (manifest as { routes?: AstroManifestRouteLike[] }).routes;
        sources = sourcesFromSsrManifest(list, astroConfig?.base ?? '/');
      },
      'astro:build:generated': ({ routeToHeaders }) => {
        // Populated only when the adapter serves static headers itself (`@astrojs/node` `staticHeaders: true`).
        nodeStaticHeaders = routeToHeaders.size > 0;
      },
      'astro:build:done': async ({ dir, assets, pages, logger }) => {
        if (!astroConfig || !loaded) return;
        const files: GeneratedFile[] = [];
        for (const [route, urls] of assets)
          for (const url of urls) files.push({ route, file: fileURLToPath(url) });
        const targets = options.targets ?? (target ? [target] : []);
        const result = await finalizeAstroBuild({
          root,
          config: effectiveConfig(loaded, facts.astroCsp),
          framework: framework(),
          routes: routes(),
          files,
          pages: pages.map((p) => p.pathname),
          clientDir: fileURLToPath(dir),
          serverDir: fileURLToPath(astroConfig.build.server),
          outDir: fileURLToPath(astroConfig.outDir),
          base: astroConfig.base,
          assetsDir: astroConfig.build.assets,
          trailingSlash: astroConfig.trailingSlash,
          targets,
          nodeStaticHeaders,
          loaded,
          ...(options.vercel?.middleware === false ? { vercelMiddleware: false } : {}),
          log: astroLogger(logger),
        });
        host?.api.setManifest(result.manifest);
      },
    },
  };
}

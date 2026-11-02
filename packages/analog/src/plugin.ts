import { resolve } from 'node:path';
import type { HypDrivConfig } from '@hypdriv/core';
import { installedVersion } from '@hypdriv/core/node';
import { createHandler, type HypHandler } from '@hypdriv/runtime';
import { connectMiddleware, developmentManifest, type LoadedHypConfig, loadHypConfig } from '@hypdriv/vite';
import type { Plugin } from 'vite';
import { discoverAnalogPages } from './routes';
import { viteState } from './state';

/** Options of the Hypdriv Vite plugin for Analog. */
export interface HypdrivAnalogPluginOptions {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the Vite root) or an inline config. */
  config?: string | HypDrivConfig;
  /** Answer `/_hypdriv/*` (health, vitals, CSP reports) from `vite dev` (default true). */
  dev?: boolean;
  /** Analog's `sourceRoot`, for the development route list (default `src`). */
  sourceRoot?: string;
}

/**
 * The Vite half of the Analog integration. It makes the client build write `.vite/manifest.json` (the source of the
 * per-page assets, Early Hints and budgets), records the resolved output layout for the Nitro module, and answers
 * `/_hypdriv/*` in `vite dev`. Place it next to Analog's plugin; the Nitro half is {@link hypdrivAnalog}
 * (`analog({ nitro: { modules: [hypdrivAnalog()] } })`, or `withHypDriv()`).
 */
export function hypdriv(options: HypdrivAnalogPluginOptions = {}): Plugin {
  let root = process.cwd();
  let loaded: Promise<LoadedHypConfig> | null = null;
  let devHandler: HypHandler | null = null;
  return {
    name: 'hypdriv:analog',
    config() {
      // The manifest is a client-build artefact; the SSR build has its own bundles.
      return { environments: { client: { build: { manifest: true } } } };
    },
    configResolved(resolved) {
      root = resolved.root;
      const client = resolved.environments?.client?.build;
      const state = viteState();
      state.root = resolved.root;
      state.base = resolved.base;
      state.manifest = !!client?.manifest;
      if (client) {
        state.assetsDir = client.assetsDir;
        state.clientOutDir = resolve(resolved.root, client.outDir);
      }
    },
    configureServer(server) {
      if (options.dev === false) return;
      server.middlewares.use(
        connectMiddleware({
          handler: (async (request, input) => {
            if (!devHandler) {
              loaded ??= loadHypConfig(root, options.config);
              const config = await loaded;
              const version = installedVersion(root, '@analogjs/platform');
              const routes = discoverAnalogPages({
                root,
                ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
              });
              devHandler = createHandler({
                config: config.resolved,
                manifest: developmentManifest(
                  {
                    name: 'analog',
                    version: version ?? '0.0.0',
                    bundler: 'vite',
                    bundlerVersion: installedVersion(root, 'vite') ?? '0.0.0',
                  },
                  routes,
                ),
                host: 'analog',
                target: 'node',
                development: true,
              });
            }
            return devHandler(request, input);
          }) as HypHandler,
          // Only Hypdriv's own routes: Vite and Analog's dev server render the application.
          wants: () => false,
          render: async () => null,
        }),
      );
    },
  };
}

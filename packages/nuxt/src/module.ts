import { relative } from 'node:path';
import type { HypDrivConfig, Logger } from '@hypdriv/core';
import {
  configModuleCode,
  developmentManifest,
  type FinalizeResult,
  type LoadedHypConfig,
  loadHypConfig,
  manifestModuleCode,
  VIRTUAL_CONFIG,
  VIRTUAL_MANIFEST,
} from '@hypdriv/vite';
import type { Nitro, NitroConfig } from 'nitropack';
import {
  addImports,
  addNitroPlugin,
  addPlugin,
  addTemplate,
  createResolver,
  defineNuxtModule,
  getNitroVersion,
  getNuxtVersion,
  resolvePath,
  useLogger,
} from 'nuxt/kit';
import { version as viteVersion } from 'vite';
import { readNuxtClientManifest } from './build/client-manifest';
import { cloudflareEntryCode, cloudflareExportsCode } from './build/cloudflare';
import {
  assertFinalized,
  completeNuxtOutput,
  finalizeNuxtManifest,
  type PrerenderedRoute,
} from './build/finalize';
import { escapeRegExp, runtimePackages, withExternal } from './build/nitro-config';
import { discoverRoutes, type NitroHandlerLike, type NuxtPageLike } from './build/routes';
import { isStaticPreset, supportsWorkerEntry, targetOfPreset } from './build/targets';
import { type NuxtRuntimeOptions, VIRTUAL_CLOUDFLARE_EXPORTS, VIRTUAL_OPTIONS } from './runtime/options';

/** Options of the `@hypdriv/nuxt` module (`hypdriv: { … }` in `nuxt.config.ts`). */
export interface ModuleOptions {
  /** The HypDriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /** Run the pipeline in `nuxt dev` (default true). */
  dev?: boolean;
  /**
   * Hand the request's CSP nonce to Nuxt, which stamps it on every `<script>`, `<style>` and script/style
   * `<link>` it renders (default true). The pipeline's injection covers the rest either way.
   */
  nonce?: boolean;
  /**
   * Write the static header rules (security headers, the hash CSP of prerendered documents, Early Hints) into
   * Cloudflare's `_headers` / Vercel's Build Output `config.json` (default true).
   */
  staticHeaders?: boolean;
  cloudflare?: {
    /**
     * Build the `cloudflare-module` Worker with HypDriv's entry: the HypDriv Worker shell (`createWorker`) around
     * Nitro, with `scheduled` / `queue` / `email` dispatch and the HypDriv Durable Objects exported (default true).
     */
    worker?: boolean;
    /**
     * A module whose named exports the Worker entry re-exports (your own Durable Objects, Workflows,
     * `WorkerEntrypoint`s), e.g. `'~~/server/worker-exports'`.
     */
    exports?: string;
  };
}

function toHypLogger(logger: ReturnType<typeof useLogger>): Logger {
  const fmt = (message: string, fields?: Record<string, unknown>) =>
    fields && Object.keys(fields).length ? `${message} ${JSON.stringify(fields)}` : message;
  const out: Logger = {
    level: 'info',
    debug: (m, f) => logger.debug(fmt(m, f)),
    info: (m, f) => logger.info(fmt(m, f)),
    warn: (m, f) => logger.warn(fmt(m, f)),
    error: (m, f) => logger.error(fmt(m, f)),
    child: () => out,
  };
  return out;
}

function withSlashes(path: string): string {
  const p = `/${path}/`.replace(/\/{2,}/g, '/');
  return p;
}

/**
 * `@hypdriv/nuxt` — runs the HypDriv Drivetrain around every Nitro response of a Nuxt 4 app and writes the build
 * manifest and the platform's static headers.
 *
 * ```ts
 * // nuxt.config.ts
 * export default defineNuxtConfig({ modules: ['@hypdriv/nuxt'] });
 * ```
 */
export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@hypdriv/nuxt',
    configKey: 'hypdriv',
    compatibility: { nuxt: '>=4.6.0' },
  },
  defaults: {
    dev: true,
    nonce: true,
    staticHeaders: true,
    cloudflare: { worker: true },
  },
  async setup(options, nuxt) {
    const nitroMajor = getNitroVersion(nuxt);
    if (nitroMajor !== undefined && nitroMajor !== 2)
      throw new Error(
        `@hypdriv/nuxt: this Nuxt builds on Nitro ${nitroMajor}; the module supports Nuxt 4 on Nitro 2 (h3 1.x).`,
      );
    const { resolve } = createResolver(import.meta.url);
    // The module's output directory: runtime files and the chunks they share are bundled into the application.
    const packageDir = resolve('.');
    const logger = useLogger('hypdriv');
    const log = toHypLogger(logger);
    const rootDir = nuxt.options.rootDir;
    const loaded: LoadedHypConfig = await loadHypConfig(rootDir, options.config);
    const buildAssetsPath = withSlashes(`${nuxt.options.app.baseURL}/${nuxt.options.app.buildAssetsDir}`);

    // Composables work in every mode (they return null when HypDriv did not handle the request).
    const composables = resolve('./runtime/composables');
    addImports([
      { name: 'useHyp', from: composables },
      { name: 'useHypNonce', from: composables },
    ]);
    nuxt.options.build.transpile.push(packageDir);

    if (nuxt.options.dev && options.dev === false) return;

    if (options.nonce !== false) addPlugin({ src: resolve('./runtime/nonce.server'), mode: 'server' });
    addNitroPlugin({ nitro2: resolve('./runtime/nitro-plugin') });

    const exportsModule = options.cloudflare?.exports
      ? await resolvePath(options.cloudflare.exports, { cwd: rootDir })
      : null;
    // The Worker entry: Nitro's polyfills first (module evaluation order), then HypDriv's Worker and the exports.
    const workerEntry = addTemplate({
      filename: 'hypdriv/cloudflare-entry.mjs',
      write: true,
      getContents: () => cloudflareEntryCode(resolve('./runtime/cloudflare-worker')),
    });

    const state: {
      nitro: Nitro | null;
      pages: NuxtPageLike[] | null;
      prerendered: PrerenderedRoute[];
      result: FinalizeResult | null;
    } = { nitro: null, pages: null, prerendered: [], result: null };

    const framework = () => ({
      name: 'nuxt' as const,
      version: getNuxtVersion(nuxt),
      bundler: 'vite',
      bundlerVersion: viteVersion,
      ...(state.nitro?.options.preset ? { adapter: state.nitro.options.preset } : {}),
    });
    const routes = () => {
      const nitro = state.nitro;
      const handlers: NitroHandlerLike[] = nitro
        ? [
            ...((nitro as unknown as { scannedHandlers?: NitroHandlerLike[] }).scannedHandlers ?? []),
            ...(nitro.options.handlers as NitroHandlerLike[]),
          ]
        : [];
      return discoverRoutes({
        pages: nuxt.options.pages === false ? null : state.pages,
        handlers,
        rootDir,
        renderers: [nitro?.options.renderer],
        buildAssetsPath,
      });
    };
    const target = () => {
      const platform = loaded.resolved.platform;
      return platform !== 'auto' ? platform : targetOfPreset(state.nitro?.options.preset);
    };
    const runtimeOptions = (): NuxtRuntimeOptions => {
      const runtimeTarget = nuxt.options.dev ? undefined : target();
      return {
        ...(runtimeTarget ? { target: runtimeTarget } : {}),
        buildAssetsPath,
        nonce: options.nonce !== false,
        socketIp: (runtimeTarget ?? 'node') === 'node' && loaded.resolved.security.trustedProxies === 0,
      };
    };

    nuxt.hook('pages:resolved', (pages) => {
      state.pages = pages as NuxtPageLike[];
    });

    nuxt.hook('nitro:config', (nitroConfig) => {
      // Nuxt types the hook for every Nitro major; this module runs on Nitro 2.
      const config = nitroConfig as unknown as NitroConfig;
      config.virtual ||= {};
      config.virtual[VIRTUAL_CONFIG] = () => configModuleCode(loaded);
      config.virtual[VIRTUAL_MANIFEST] = () =>
        manifestModuleCode(state.result?.manifest ?? developmentManifest(framework(), routes()));
      config.virtual[VIRTUAL_OPTIONS] = () => `export default ${JSON.stringify(runtimeOptions())};\n`;
      config.virtual[VIRTUAL_CLOUDFLARE_EXPORTS] = () => cloudflareExportsCode(exportsModule);
      // Bundle the runtime and HypDriv's packages: they import the virtual modules and Nitro's build constants.
      config.externals ||= {};
      config.externals.inline ||= [];
      config.externals.inline.push(packageDir, '@hypdriv/');
      // `@hypdriv/runtime` imports `cloudflare:workers` lazily, only inside workerd.
      config.rollupConfig ||= {};
      config.rollupConfig.external = withExternal(config.rollupConfig.external, /^cloudflare:/);
      // Nitro's auto-imports must not rewrite the runtime (its `CaptureResponse` has methods named like h3 utils).
      if (config.imports !== false) {
        config.imports ||= {};
        const exclude = config.imports.exclude;
        const own = new RegExp(`^${escapeRegExp(packageDir)}`);
        config.imports.exclude = [
          ...(exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude]),
          own,
        ];
      }
      // `nuxt dev` loads server dependencies from disk instead of bundling them: point HypDriv's packages at the
      // files this module resolves (the application need not depend on them directly).
      if (nuxt.options.dev) {
        config.alias ||= {};
        for (const [specifier, file] of Object.entries(runtimePackages())) config.alias[specifier] ??= file;
      }
    });

    const finalize = async (): Promise<FinalizeResult> => {
      if (state.result) return state.result;
      const nitro = state.nitro;
      if (!nitro) throw new Error('hypdriv: Nitro is not initialised');
      const result = await finalizeNuxtManifest({
        rootDir,
        srcDir: nuxt.options.srcDir,
        config: loaded.resolved,
        framework: framework(),
        ...(nuxt.options.buildId ? { buildId: nuxt.options.buildId } : {}),
        baseURL: nuxt.options.app.baseURL || '/',
        buildAssetsPath,
        routes: routes(),
        prerendered: state.prerendered,
        publicDir: nitro.options.output.publicDir,
        clientManifest: await readNuxtClientManifest(nuxt.options.buildDir),
        log,
      });
      assertFinalized(result);
      state.result = result;
      return result;
    };

    nuxt.hook('nitro:init', (instance) => {
      const nitro = instance as unknown as Nitro;
      state.nitro = nitro;
      const preset = nitro.options.preset;
      if (exportsModule && !supportsWorkerEntry(preset) && !nuxt.options.dev)
        log.warn(
          `hypdriv: cloudflare.exports only applies to the cloudflare-module preset (building ${preset})`,
        );
      // The main Nitro instance only: the prerenderer is created from the initial config and runs on Node.
      if (!nuxt.options.dev && options.cloudflare?.worker !== false && supportsWorkerEntry(preset))
        nitro.options.entry = workerEntry.dst;

      nitro.hooks.hook('prerender:done', ({ prerenderedRoutes }) => {
        state.prerendered = prerenderedRoutes.map((r) => ({
          route: r.route,
          ...(r.fileName ? { fileName: r.fileName } : {}),
          ...(r.contentType ? { contentType: r.contentType } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(r.skip ? { skip: r.skip } : {}),
        }));
      });

      nitro.hooks.hook('compiled', async () => {
        if (nuxt.options.dev) return;
        const result = await finalize();
        if (isStaticPreset(nitro.options.preset) && target() === 'node') return;
        const out = completeNuxtOutput({
          target: target(),
          config: loaded.resolved,
          result,
          publicDir: nitro.options.output.publicDir,
          outputDir: nitro.options.output.dir,
          serverDir: nitro.options.output.serverDir,
          staticHeaders: options.staticHeaders !== false,
          log,
        });
        if (!out.embedded.length)
          log.warn(
            'hypdriv: no server file embeds the runtime manifest; the HypDriv Nitro plugin is not part of this build',
          );
        logger.info(
          `hypdriv: ${target()} output completed (final manifest in ${out.embedded.length} server file(s)${
            out.patched.length ? `, ${out.patched.length} patched` : ''
          }${out.headersFile ? `, static headers in ${relative(rootDir, out.headersFile)}` : ''})`,
        );
      });
    });

    // After Nuxt copied the client build into Nitro's public directory and before Nitro bundles the server: the
    // server bundle embeds the final manifest (and `compiled` re-checks it in every output file).
    nuxt.hook('nitro:build:public-assets', async () => {
      if (!nuxt.options.dev) await finalize();
    });
  },
});

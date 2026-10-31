import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { type HypDrivConfig, loadConfig, type ManifestFramework } from '@hypdriv/core';
import {
  addVercelMiddleware,
  type HostPluginApi,
  hostPlugin,
  patchRuntimeManifest,
  writeCloudflareStatic,
} from '@hypdriv/vite';
import type { Adapter, AdapterViteConfig, Builder } from '@sveltejs/kit';
import { VERSION } from '@sveltejs/kit';
import { type Plugin, version as viteVersion } from 'vite';
import { type BuilderLike, builderLogger, embeddedManifests, prepareBuild } from './build';
import { type SvelteKitCsp, svelteKitDirectives, withSvelteKitCsp } from './csp';
import { discoverRoutes } from './routes';
import { cloudflareLayout, readWranglerConfig, wrapWorker } from './targets/cloudflare';
import { writeVercelHeaders } from './targets/vercel';

/** The platforms Hypdriv writes static configuration for. */
export type SvelteKitTarget = 'cloudflare' | 'vercel' | 'node';

export interface HypDrivSvelteKitOptions {
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the project root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * The platform the adapter builds for. Default: from the adapter (`@sveltejs/adapter-cloudflare`, `-vercel`,
   * `-node`; `adapter-auto` by its environment), else from the output it wrote.
   */
  target?: SvelteKitTarget;
  cloudflare?: {
    /**
     * Put Hypdriv's Worker shell in front of the adapter's Worker (Durable Objects, `scheduled` / `queue` / `email`
     * handlers, the Drivetrain for responses SvelteKit sends before `handle`). Default: true for Workers, false for
     * Pages (Pages Functions cannot export Durable Objects or cron handlers).
     */
    worker?: boolean;
    /**
     * A module whose named exports the Worker re-exports next to Hypdriv's Durable Objects: your own Durable
     * Objects, Workflows and `WorkerEntrypoint`s (path relative to the project root).
     */
    exports?: string;
    /** The wrangler config file, when you pass `config` to adapter-cloudflare. */
    wranglerConfig?: string;
  };
  node?: {
    /** adapter-node's `out` option (default `build`). */
    out?: string;
  };
  vercel?: {
    /**
     * Run Hypdriv's Routing Middleware for prerendered pages, which Vercel's CDN serves without SvelteKit's
     * function (rate limiting, bot shield, maintenance, redirects, geo; default true). On-demand routes run the
     * pipeline in the function's `handle` either way.
     */
    middleware?: boolean;
  };
}

/** The virtual module that carries SvelteKit's settings (its `csp` option) into the server build. */
export const VIRTUAL_SVELTEKIT = 'virtual:hypdriv/sveltekit';
const RESOLVED_SVELTEKIT = `\0${VIRTUAL_SVELTEKIT}`;

type KitConfig = Builder['config'];

/** SvelteKit's `csp` option in the shape the runtime needs (null when it sets no directive). */
export function kitCsp(
  config: Pick<KitConfig, 'csp'> | { csp?: unknown } | null | undefined,
): SvelteKitCsp | null {
  const csp = (config as { csp?: SvelteKitCsp } | null | undefined)?.csp;
  if (!csp) return null;
  const directives = svelteKitDirectives(csp.directives);
  if (!directives) return null;
  return {
    ...(csp.mode ? { mode: csp.mode } : {}),
    directives: Object.fromEntries(
      Object.entries(csp.directives ?? {}).filter(([, v]) => v !== undefined && v !== false),
    ),
  };
}

/** Maps an adapter name to its platform (`adapter-auto` by the environment it builds in). */
export function targetOf(
  name: string,
  env: Record<string, string | undefined> = process.env,
): SvelteKitTarget | null {
  if (name === '@sveltejs/adapter-cloudflare' || name === '@sveltejs/adapter-cloudflare-workers')
    return 'cloudflare';
  if (name === '@sveltejs/adapter-vercel') return 'vercel';
  if (name === '@sveltejs/adapter-node') return 'node';
  if (name === '@sveltejs/adapter-auto') {
    if (env.VERCEL) return 'vercel';
    if (env.CF_PAGES || env.WORKERS_CI) return 'cloudflare';
  }
  return null;
}

function frameworkInfo(target: SvelteKitTarget | null): ManifestFramework {
  return {
    name: 'sveltekit',
    version: VERSION,
    bundler: 'vite',
    bundlerVersion: viteVersion,
    ...(target ? { adapter: target } : {}),
  };
}

interface State {
  kit: KitConfig | null;
  /** The host plugin whose `configResolved` ran in this process (the one of the running build). */
  host: (Plugin & { api: HostPluginApi }) | null;
}

/** Hypdriv's Vite plugins for a SvelteKit app (contributed through the adapter, before SvelteKit's own). */
function plugins(
  state: State,
  options: HypDrivSvelteKitOptions,
  target: () => SvelteKitTarget | null,
): Plugin[] {
  const host = hostPlugin({
    name: 'hypdriv:sveltekit',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework: () => frameworkInfo(target()),
    routes: () => discoverRoutes(host.api.root, state.kit?.files?.routes ?? 'src/routes'),
    // The hook imports `$app/env` and the virtual modules: it must be bundled with the application's server code.
    noExternal: ['@hypdriv/sveltekit'],
  });
  const env: Plugin = {
    name: 'hypdriv:sveltekit-env',
    enforce: 'pre',
    sharedDuringBuild: true,
    configResolved() {
      state.host = host;
    },
    resolveId(id) {
      return id === VIRTUAL_SVELTEKIT ? RESOLVED_SVELTEKIT : null;
    },
    load(id) {
      if (id !== RESOLVED_SVELTEKIT) return null;
      return `export const kit = ${JSON.stringify({ csp: kitCsp(state.kit) })};\n`;
    },
  };
  return [host, env];
}

/**
 * Wraps a SvelteKit adapter with Hypdriv:
 *
 * ```ts
 * // vite.config.ts
 * import adapter from '@sveltejs/adapter-cloudflare';
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { hypdriv } from '@hypdriv/sveltekit';
 *
 * export default defineConfig({ plugins: [sveltekit({ adapter: hypdriv(adapter()) })] });
 * ```
 *
 * It contributes the Vite plugins behind `@hypdriv/sveltekit/hooks` (config and manifest modules) and, after
 * SvelteKit built and prerendered the app, writes the manifest (`.hypdriv/`), patches it into the server output,
 * runs the adapter, then writes the platform's static headers (Cloudflare `_headers`, Vercel `config.json` routes)
 * and, on Cloudflare Workers, puts Hypdriv's Worker shell in front of the adapter's Worker.
 */
export function hypdriv(adapter: Adapter, options: HypDrivSvelteKitOptions = {}): Adapter {
  const state: State = { kit: null, host: null };
  const target = (): SvelteKitTarget | null => options.target ?? targetOf(adapter.name);
  const innerVite = adapter.vite;
  return {
    ...adapter,
    vite: (ctx) => {
      state.kit = ctx.config;
      const inner: AdapterViteConfig = typeof innerVite === 'function' ? innerVite(ctx) : (innerVite ?? {});
      const list = Array.isArray(inner.plugins) ? { pre: inner.plugins } : (inner.plugins ?? {});
      return {
        ...inner,
        plugins: {
          pre: [...plugins(state, options, target), ...(list.pre ?? [])],
          ...(list.post ? { post: list.post } : {}),
        },
      };
    },
    async adapt(builder) {
      const host = state.host;
      if (!host)
        throw new Error(
          'hypdriv: the Hypdriv Vite plugins did not run; pass the wrapped adapter to sveltekit({ adapter: hypdriv(adapter()) })',
        );
      const root = host.api.root;
      const log = builderLogger(builder.log);
      const loaded = await host.api.config();
      const csp = kitCsp(builder.config);
      if (csp && svelteKitDirectives(builder.config.csp.reportOnly as SvelteKitCsp['reportOnly']))
        log.warn(
          "hypdriv: SvelteKit's csp.reportOnly policy is replaced by Hypdriv's single policy; use security.csp.reportOnly in hypdriv.config to roll out report-only",
        );
      const config = loadConfig(withSvelteKitCsp(loaded.raw, csp));
      const prepared = await prepareBuild({
        root,
        builder: builder as unknown as BuilderLike,
        config,
        framework: frameworkInfo(target()),
      });
      host.api.setManifest(prepared.manifest);

      await adapter.adapt(builder);

      const platform = target() ?? detectTarget(root, builder, options);
      let shell = false;
      // Server output the deployment runs: the adapter copied or bundled SvelteKit's (already patched) output there.
      const outputs: string[] = [builder.getServerDirectory()];
      if (platform === 'cloudflare') {
        const wrangler = await readWranglerConfig(root, options.cloudflare?.wranglerConfig);
        const layout = cloudflareLayout({
          root,
          buildDir: builder.getBuildDirectory('cloudflare'),
          wrangler,
        });
        const { dropped } = writeCloudflareStatic({
          assetsDir: layout.assetsDir,
          rules: prepared.rules,
          log,
        });
        log.info(
          `hypdriv: ${prepared.rules.length - dropped.length} static header rule(s) → ${relative(root, join(layout.assetsDir, '_headers'))}`,
        );
        shell = options.cloudflare?.worker ?? !layout.pages;
        if (shell) {
          wrapWorker({
            layout,
            buildDir: builder.getBuildDirectory('hypdriv'),
            config: loaded,
            csp,
            manifest: prepared.manifest,
            exports: options.cloudflare?.exports,
            root,
          });
          log.info(`hypdriv: Worker shell → ${relative(root, layout.workerFile)}`);
        }
        outputs.push(
          layout.assetsDir,
          dirname(layout.workerFile),
          builder.getBuildDirectory('cloudflare-tmp'),
        );
      } else if (platform === 'vercel') {
        const output = join(root, '.vercel', 'output');
        const { routes } = writeVercelHeaders(output, prepared.rules);
        log.info(`hypdriv: ${routes} header route(s) → .vercel/output/config.json`);
        await addVercelMiddleware({
          root,
          outputDir: output,
          config: loaded,
          manifest: prepared.manifest,
          paths: options.vercel?.middleware === false ? [] : prepared.documents,
          log,
        });
        outputs.push(join(output, 'functions'));
      } else if (platform === 'node') {
        const out = resolve(root, options.node?.out ?? 'build');
        if (!existsSync(join(out, 'handler.js')))
          log.warn(
            `hypdriv: ${relative(root, out)}/handler.js not found; set node.out to adapter-node's out`,
          );
        outputs.push(out);
      } else {
        log.warn(
          `hypdriv: unknown deployment target for ${adapter.name}; set the target option to write static headers`,
        );
      }
      patchRuntimeManifest(outputs, prepared.manifest);
      const { current, stale } = embeddedManifests(outputs, prepared.manifest);
      if (stale.length)
        throw new Error(
          `hypdriv: the final manifest could not be written into ${stale.map((f) => relative(root, f)).join(', ')}`,
        );
      if (current.length) log.info(`hypdriv: final manifest embedded in ${current.length} server file(s)`);

      if (!prepared.patched.length && !shell)
        log.warn(
          "hypdriv: the Hypdriv handle is not in the server build. Add it to src/hooks.server.ts: export const handle = sequence(hypdriv(), …) with hypdriv from '@hypdriv/sveltekit/hooks'",
        );
    },
  };
}

function detectTarget(
  root: string,
  builder: Pick<Builder, 'getBuildDirectory'>,
  options: HypDrivSvelteKitOptions,
): SvelteKitTarget | null {
  if (process.env.VERCEL && existsSync(join(root, '.vercel', 'output', 'config.json'))) return 'vercel';
  if (existsSync(join(builder.getBuildDirectory('cloudflare'), '_worker.js'))) return 'cloudflare';
  if (existsSync(join(resolve(root, options.node?.out ?? 'build'), 'handler.js'))) return 'node';
  return null;
}

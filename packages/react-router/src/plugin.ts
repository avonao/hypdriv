import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { HypDrivConfig, ManifestFramework } from '@hypdriv/core';
import { installedVersion } from '@hypdriv/core/node';
import { createHandler, type HypHandler } from '@hypdriv/runtime';
import {
  connectMiddleware,
  developmentManifest,
  hostPlugin,
  MANIFEST_SENTINEL_VALUE,
  VIRTUAL_MANIFEST,
} from '@hypdriv/vite';
import type { Plugin, PluginOption } from 'vite';
import { developmentRoutes } from './build';
import { HOST, PRERENDER_HEADER, VIRTUAL_REACT_ROUTER, VIRTUAL_SERVER_ENTRY } from './shared';
import { type ReactRouterTarget, registry, rootState } from './state';

export interface HypDrivReactRouterOptions {
  /** The HypDriv config: a file path (default `hypdriv.config.*` in the Vite root) or an inline config. */
  config?: string | HypDrivConfig;
  /**
   * Where the build deploys. Default: `HYPDRIV_TARGET`, else `vercel` on Vercel (`VERCEL=1`), else `cloudflare` when
   * `@cloudflare/vite-plugin` is in the config, else `node`.
   */
  target?: ReactRouterTarget;
  /**
   * Node and Vercel builds: make HypDriv's server entry the SSR entry, so `build/server/index.js` also exports a
   * full-response handler (`default`, and `hypdriv` for the Node server) that runs the pipeline around every
   * request — 404s, `/__manifest` and static files included. Ignored on Cloudflare (the Worker is the entry) and
   * when the config sets its own SSR input. Default true.
   */
  serverEntry?: boolean;
  /** `react-router dev` on Node: answer `/_hypdriv/*` from the dev server (default true). */
  dev?: boolean;
}

const REACT_ROUTER_SERVER_BUILD = 'virtual:react-router/server-build';
const RESOLVED_REACT_ROUTER = `\0${VIRTUAL_REACT_ROUTER}`;
const RESOLVED_SERVER_ENTRY = `\0${VIRTUAL_SERVER_ENTRY}`;
const RESOLVED_MANIFEST = `\0${VIRTUAL_MANIFEST}`;

function flattenPlugins(options: PluginOption[] | undefined): Plugin[] {
  const out: Plugin[] = [];
  const visit = (option: PluginOption) => {
    if (!option || option instanceof Promise) return;
    if (Array.isArray(option)) option.forEach(visit);
    else out.push(option as Plugin);
  };
  (options ?? []).forEach(visit);
  return out;
}

/** Whether `@cloudflare/vite-plugin` is part of a plugin list. */
export function hasCloudflarePlugin(plugins: readonly PluginOption[] | undefined): boolean {
  return flattenPlugins(plugins as PluginOption[]).some((p) =>
    typeof p.name === 'string' ? p.name.startsWith('vite-plugin-cloudflare') : false,
  );
}

/** The deployment target of a build (see `HypDrivReactRouterOptions.target`). */
export function detectTarget(
  explicit: ReactRouterTarget | undefined,
  plugins: readonly PluginOption[] | undefined,
  env: Record<string, string | undefined> = process.env,
): ReactRouterTarget {
  if (explicit) return explicit;
  const named = env.HYPDRIV_TARGET;
  if (named === 'cloudflare' || named === 'vercel' || named === 'node') return named;
  if (env.VERCEL === '1') return 'vercel';
  if (hasCloudflarePlugin(plugins)) return 'cloudflare';
  return 'node';
}

/** Source of HypDriv's SSR entry for Node and Vercel builds. */
export function serverEntryCode(): string {
  return [
    "export * from 'virtual:react-router/server-build';",
    "import * as build from 'virtual:react-router/server-build';",
    "import config from 'virtual:hypdriv/config';",
    "import manifest from 'virtual:hypdriv/manifest';",
    `import { prerenderToken } from ${JSON.stringify(VIRTUAL_REACT_ROUTER)};`,
    "import { createServerEntry } from '@hypdriv/react-router/server';",
    '',
    '/** HypDriv around the whole app: the Node server and Vercel functions call this for every request. */',
    'export const hypdriv = createServerEntry({ build, config, manifest, prerenderToken });',
    'export default function handler(request) {',
    '  return hypdriv.fetch(request);',
    '}',
    '',
  ].join('\n');
}

/**
 * The HypDriv Vite plugin for React Router apps (use it with `hypdrivPreset()` in `react-router.config.ts`):
 * serves `virtual:hypdriv/config`, `virtual:hypdriv/manifest` and the build's prerender token to the server code,
 * makes HypDriv's server entry the SSR entry of Node and Vercel builds, marks React Router's prerender requests on
 * the build-time preview server, and answers `/_hypdriv/*` in `react-router dev`.
 *
 * ```ts
 * // vite.config.ts
 * import { reactRouter } from '@react-router/dev/vite';
 * import { hypdriv } from '@hypdriv/react-router';
 * export default defineConfig({ plugins: [hypdriv(), reactRouter()] });
 * ```
 */
export function hypdriv(options: HypDrivReactRouterOptions = {}): Plugin[] {
  let root = process.cwd();
  let command: 'build' | 'serve' = 'serve';
  let preview = false;
  let target: ReactRouterTarget = options.target ?? 'node';
  const framework = (): ManifestFramework => ({
    name: 'react-router',
    version: installedVersion(root, 'react-router') ?? 'unknown',
    bundler: 'vite',
    bundlerVersion: installedVersion(root, 'vite') ?? 'unknown',
  });
  const routes = () => {
    const resolved = registry().resolved;
    return resolved ? developmentRoutes(resolved, root) : [];
  };
  const host = hostPlugin({
    name: 'hypdriv:react-router-host',
    ...(options.config !== undefined ? { config: options.config } : {}),
    framework,
    routes,
    noExternal: ['@hypdriv/react-router'],
  });
  const hostLoad = host.load as (this: unknown, id: string) => Promise<string | null>;
  const hostWithTracking: Plugin = {
    ...host,
    async load(id) {
      const code = await hostLoad.call(this, id);
      // Remember that a server environment bundled the runtime manifest: the build must find it to patch it.
      const env = (this as { environment?: { config?: { consumer?: string } } }).environment;
      if (id === RESOLVED_MANIFEST && command === 'build' && env?.config?.consumer !== 'client' && code)
        rootState(root).manifestBundled = code.includes(MANIFEST_SENTINEL_VALUE);
      return code;
    },
  };

  let devHandler: HypHandler | null = null;
  const plugin: Plugin = {
    name: 'hypdriv:react-router',
    enforce: 'pre',
    sharedDuringBuild: true,
    config(user, env) {
      preview = env.isPreview === true;
      if (env.command !== 'build' || preview) return;
      target = detectTarget(options.target, user.plugins);
      rootState(resolve(process.cwd(), user.root ?? '.')).target = target;
    },
    configEnvironment(name, environment, env) {
      // React Router's server environments (`ssr`, or one per server bundle) build `virtual:react-router/server-build`
      // by default: Node and Vercel builds get HypDriv's entry instead, which re-exports it. Custom inputs stay.
      if (env.command !== 'build' || preview || target === 'cloudflare' || options.serverEntry === false)
        return;
      if (name !== 'ssr' && !name.startsWith('ssrBundle_')) return;
      const build = environment.build as
        | { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } }
        | undefined;
      const rollup = build?.rolldownOptions ?? build?.rollupOptions;
      if (rollup && rollup.input === REACT_ROUTER_SERVER_BUILD) rollup.input = VIRTUAL_SERVER_ENTRY;
    },
    configResolved(resolved) {
      root = resolved.root;
      command = resolved.command;
      const state = rootState(root);
      if (command === 'build' && !preview) {
        state.api = host.api;
        state.target ??= detectTarget(options.target, resolved.plugins);
        // One random token per build process: React Router's prerender requests carry it, production never does.
        state.token ??= randomBytes(32).toString('hex');
        // React Router resolved its config (and ran the presets' hooks) in its own `config` hook.
        if (resolved.plugins.some((p) => p.name === 'react-router') && !registry().presetInstalled)
          resolved.logger?.warn(
            'hypdriv: hypdrivPreset() is missing from react-router.config.ts; the build gets no HypDriv manifest, static headers or platform output',
          );
      }
    },
    onLog(_level, log) {
      // The runtime imports the virtual modules lazily (it also runs outside Vite builds); HypDriv's server entry
      // imports them statically. Both end up in one chunk, which is what the warning reports.
      if (log.code === 'INEFFECTIVE_DYNAMIC_IMPORT' && log.message.includes('virtual:hypdriv/')) return false;
      return undefined;
    },
    resolveId(id) {
      if (id === VIRTUAL_REACT_ROUTER) return RESOLVED_REACT_ROUTER;
      if (id === VIRTUAL_SERVER_ENTRY) return RESOLVED_SERVER_ENTRY;
      return null;
    },
    load(id) {
      if (id === RESOLVED_REACT_ROUTER) {
        const token = command === 'build' && !preview ? (rootState(root).token ?? '') : '';
        return `export const prerenderToken = ${JSON.stringify(token)};\n`;
      }
      if (id === RESOLVED_SERVER_ENTRY) return serverEntryCode();
      return null;
    },
    configurePreviewServer(server) {
      // React Router prerenders through a preview server it starts during the build (same process).
      const token = rootState(server.config.root).token;
      if (!token || process.env.IS_RR_BUILD_REQUEST !== 'yes') return;
      server.middlewares.use((req, _res, next) => {
        const headers = req.headers;
        for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
          if (req.rawHeaders[i]!.toLowerCase() === PRERENDER_HEADER) req.rawHeaders.splice(i, 2);
        }
        delete headers[PRERENDER_HEADER];
        if (headers['x-react-router-prerender'] === 'yes' || headers['x-react-router-spa-mode'] === 'yes') {
          headers[PRERENDER_HEADER] = token;
          req.rawHeaders.push(PRERENDER_HEADER, token);
        }
        next();
      });
    },
    configureServer(server) {
      // `/_hypdriv/*` in `react-router dev` on Node (a Cloudflare dev server runs the Worker, which answers them).
      if (options.dev === false || hasCloudflarePlugin(server.config.plugins)) return;
      server.middlewares.use(
        connectMiddleware({
          handler: (async (request, input) => {
            if (!devHandler) {
              const loaded = await host.api.config();
              devHandler = createHandler({
                config: loaded.resolved,
                manifest: host.api.manifest() ?? developmentManifest(framework(), routes()),
                host: HOST,
                target: 'node',
                development: true,
              });
            }
            return devHandler(request, input);
          }) as HypHandler,
          wants: () => false,
          render: async () => null,
        }),
      );
    },
  };
  return [hostWithTracking, plugin];
}

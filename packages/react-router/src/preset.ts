import { resolve } from 'node:path';
import type { HypDrivConfig } from '@hypdriv/core';
import { loadHypConfig, viteLogger } from '@hypdriv/vite';
import type { Config, Preset } from '@react-router/dev/config';
import { finalizeReactRouterBuild, type ReactRouterBuildResult } from './build';
import { detectTarget } from './plugin';
import { type ResolvedReactRouterConfigLike, registry, rootState } from './state';
import type { BuildManifestLike } from './vercel';

export interface HypDrivPresetOptions {
  /** Vercel: Hypdriv's Routing Middleware in front of what Vercel serves statically (default true). */
  vercelMiddleware?: boolean;
  /**
   * The Hypdriv config when the Vite plugin is not installed (the plugin's `config` option wins otherwise): a file
   * path or an inline config. Default `hypdriv.config.*` in the root.
   */
  config?: string | HypDrivConfig;
  /** Called with the result once the build is finalised (tooling, tests). */
  onFinalized?: (result: ReactRouterBuildResult) => void | Promise<void>;
}

type BuildEndArgs = Parameters<NonNullable<Config['buildEnd']>>[0];

/**
 * The Hypdriv preset for `react-router.config.ts`. Its `buildEnd` runs after React Router finished the build
 * (prerendering included): it writes `.hypdriv/manifest.json` (routes, resource routes, per-route assets, CSP
 * hashes of prerendered pages, Early Hints), patches the final manifest into the server build, erases the
 * prerender token, and writes the platform's static configuration (Cloudflare `_headers`, or the Vercel Build
 * Output with Hypdriv's header routes, functions and Routing Middleware).
 *
 * ```ts
 * // react-router.config.ts
 * import { hypdrivPreset } from '@hypdriv/react-router';
 * export default { ssr: true, prerender: ['/'], presets: [hypdrivPreset()] } satisfies Config;
 * ```
 */
export function hypdrivPreset(options: HypDrivPresetOptions = {}): Preset {
  const buildEnd = async ({ buildManifest, reactRouterConfig, viteConfig }: BuildEndArgs): Promise<void> => {
    const root = viteConfig.root;
    const state = rootState(root);
    const log = viteLogger(viteConfig);
    if (!state.api)
      log.warn(
        'hypdriv: the Hypdriv Vite plugin is not installed (add `hypdriv()` from @hypdriv/react-router to vite.config.ts); the server build carries no Hypdriv runtime',
      );
    const config = state.api ? await state.api.config() : await loadHypConfig(root, options.config);
    const target = state.target ?? detectTarget(undefined, viteConfig.plugins);
    const serverDirs = Object.entries(viteConfig.environments ?? {})
      .filter(([name, env]) => name !== 'client' && env?.build?.outDir)
      .map(([, env]) => resolve(root, env.build.outDir));
    const result = await finalizeReactRouterBuild({
      root,
      reactRouterConfig: reactRouterConfig as unknown as ResolvedReactRouterConfigLike,
      buildManifest: buildManifest as BuildManifestLike | undefined,
      viteConfig,
      config,
      target,
      token: state.token,
      manifestBundled: state.manifestBundled,
      ...(options.vercelMiddleware !== undefined ? { vercelMiddleware: options.vercelMiddleware } : {}),
      serverDirs,
      log,
    });
    state.api?.setManifest(result.manifest);
    await options.onFinalized?.(result);
  };
  return {
    name: 'hypdriv',
    reactRouterConfig: () => ({ buildEnd }),
    reactRouterConfigResolved({ reactRouterConfig }) {
      const reg = registry();
      reg.resolved = reactRouterConfig as unknown as ResolvedReactRouterConfigLike;
      reg.presetInstalled = true;
    },
  };
}

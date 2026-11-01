import { mergeConfig, type PluginOption } from 'vite';
import type { Config } from 'waku/config';
import { type HypDrivWakuOptions, hypdriv } from './plugin';
import { ADAPTER_MODULES, detectTarget, type WakuTarget } from './target';

/** Options of `withHypDriv()`: the plugin's, with `srcDir` read from the Waku config. */
export type WithHypDrivOptions = Omit<HypDrivWakuOptions, 'srcDir'>;

/** Plugin names (nested arrays and falsy entries ignored) of a Vite `plugins` list. */
function pluginNames(plugins: PluginOption[] | undefined): string[] {
  const names: string[] = [];
  const visit = (plugin: PluginOption) => {
    if (!plugin || typeof plugin !== 'object') return;
    if (Array.isArray(plugin)) plugin.forEach(visit);
    else if ('name' in plugin && typeof plugin.name === 'string') names.push(plugin.name);
  };
  plugins?.forEach(visit);
  return names;
}

/**
 * What `@cloudflare/vite-plugin` needs from Waku's environments (Waku's Cloudflare guide): `hono/tiny` and
 * `rsc-html-stream` pre-bundled for the Worker, and platform-neutral server bundles.
 */
const CLOUDFLARE_ENVIRONMENTS = {
  environments: {
    rsc: {
      optimizeDeps: { include: ['waku > hono/tiny'] },
      build: { rolldownOptions: { platform: 'neutral' } },
    },
    ssr: {
      optimizeDeps: { include: ['waku > rsc-html-stream/server'] },
      build: { rolldownOptions: { platform: 'neutral' } },
    },
  },
};

/**
 * Wraps a Waku config for Hypdriv: selects the Hypdriv adapter of the build's target (`unstable_adapter`, unless
 * you set one) and adds the Hypdriv Vite plugin. On Cloudflare it also adds the environment settings Waku's
 * `@cloudflare/vite-plugin` setup needs; add `cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments:
 * ['ssr'] } })` to `vite.plugins` yourself for that target.
 *
 * ```ts
 * // waku.config.ts
 * import { withHypDriv } from '@hypdriv/waku';
 * import { defineConfig } from 'waku/config';
 * export default defineConfig(withHypDriv({}));
 * ```
 *
 * The target is `HYPDRIV_TARGET` (`cloudflare`, `vercel`, `node`), else Cloudflare when `@cloudflare/vite-plugin`
 * is in `vite.plugins`, else the build platform's environment (`VERCEL`, `CLOUDFLARE` / `WORKERS_CI`), else Node.
 */
export function withHypDriv(config: Config = {}, options: WithHypDrivOptions = {}): Config {
  const cloudflarePlugin = pluginNames(config.vite?.plugins).some((name) =>
    name.startsWith('vite-plugin-cloudflare'),
  );
  const target: WakuTarget | null = options.target ?? detectTarget(undefined, { cloudflarePlugin });
  const plugin = hypdriv({ ...options, ...(config.srcDir ? { srcDir: config.srcDir } : {}) });
  if (target === 'cloudflare') {
    if (!cloudflarePlugin)
      throw new Error(
        "@hypdriv/waku: the Cloudflare target needs `cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })` from @cloudflare/vite-plugin in `vite.plugins` of waku.config.ts",
      );
  }
  const vite =
    target === 'cloudflare' ? mergeConfig(CLOUDFLARE_ENVIRONMENTS, config.vite ?? {}) : (config.vite ?? {});
  return {
    ...config,
    ...(config.unstable_adapter || !target ? {} : { unstable_adapter: ADAPTER_MODULES[target] }),
    vite: { ...vite, plugins: [...(vite.plugins ?? []), plugin] },
  };
}

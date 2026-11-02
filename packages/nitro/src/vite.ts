import type { Plugin } from 'vite';
import { type HypdrivNitroOptions, hypdrivNitro, type NitroModuleLike } from './module';

/** A Vite plugin that Nitro 3's `nitro/vite` registers as a Nitro module (the plugin's `nitro` key). */
export type HypDrivNitroVitePlugin = Plugin & { nitro: NitroModuleLike };

/**
 * `@hypdriv/nitro/vite` — Hypdriv for a Vite app built on Nitro 3 (`nitro/vite`). `nitro()` registers any Vite plugin
 * that carries a `nitro` key as a Nitro module, so one entry in `plugins` is the whole setup:
 *
 * ```ts
 * // vite.config.ts
 * import { nitro } from 'nitro/vite';
 * import { hypdriv } from '@hypdriv/nitro/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({ plugins: [nitro(), hypdriv()] });
 * ```
 *
 * The plugin also turns on the Vite client build's manifest, which the build manifest reads for each page's assets.
 */
export function hypdriv(options: HypdrivNitroOptions = {}): HypDrivNitroVitePlugin {
  return {
    name: 'hypdriv:nitro',
    nitro: hypdrivNitro(options),
    config() {
      return { environments: { client: { build: { manifest: true } } } };
    },
  };
}

export type { HypdrivNitroOptions } from './module';

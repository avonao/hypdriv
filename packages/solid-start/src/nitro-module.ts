import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticHeaderRules } from '@hypdriv/build';
import { emptyManifest, type ResolvedConfig } from '@hypdriv/core';
import { VIRTUAL_CONFIG, VIRTUAL_MANIFEST } from '@hypdriv/vite';
import { PRERENDER_PRESET, VIRTUAL_OPTIONS } from './constants';
import { type NitroLike, nodeRouteRules, type SolidStartTarget, targetForNitroPreset } from './target';

/**
 * The file Nitro bundles as Hypdriv's runtime plugin: `nitro.js` next to the built Vite plugin, `nitro.ts` next to
 * the sources (tests), else the package's `@hypdriv/solid-start/nitro` export resolved from the project.
 */
export function nitroPluginPath(root: string, override?: string): string {
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of ['nitro.js', 'nitro.mjs', 'nitro.ts'].map((f) => join(here, f)))
    if (existsSync(candidate)) return candidate;
  return createRequire(join(root, 'package.json')).resolve('@hypdriv/solid-start/nitro');
}

/** What the Nitro module needs from the Vite plugin, evaluated lazily (Nitro initialises before Vite resolves). */
export interface NitroModuleInput {
  /** The Nitro runtime plugin file. */
  pluginPath: () => string;
  /** Source of `virtual:hypdriv/config`. */
  configSource: () => Promise<string>;
  /** Source of `virtual:hypdriv/manifest` (the final manifest once the build finalised it, else the development one). */
  manifestSource: () => Promise<string>;
  /** Public prefixes of content-hashed build assets. */
  assetPrefixes: () => string[];
}

/** The options the Nitro runtime plugin reads (`virtual:hypdriv/solid-start`). */
export function optionsSource(nitro: NitroLike, assetPrefixes: string[]): string {
  const target: SolidStartTarget = targetForNitroPreset(nitro.options.preset);
  return `export default ${JSON.stringify({ target, development: nitro.options.dev === true, assetPrefixes })};\n`;
}

/**
 * Installs Hypdriv into a Nitro instance: the runtime plugin that wraps `nitroApp.fetch`, and the three virtual
 * modules it imports. Nitro's prerender build (`nitro-prerender`) is left alone, so prerendered documents are what
 * SolidStart renders, with no per-request state. Returns whether the instance was set up.
 */
export function installNitroModule(nitro: NitroLike, input: NitroModuleInput): boolean {
  if (nitro.options.preset === PRERENDER_PRESET) return false;
  const plugin = input.pluginPath();
  if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin);
  nitro.options.virtual[VIRTUAL_CONFIG] = input.configSource;
  nitro.options.virtual[VIRTUAL_MANIFEST] = input.manifestSource;
  nitro.options.virtual[VIRTUAL_OPTIONS] = () => optionsSource(nitro, input.assetPrefixes());
  return true;
}

/**
 * Gives a Node server's content-hashed assets the static security headers through Nitro's route rules (Vercel and
 * Cloudflare get theirs from the build output): Nitro serves those files, and the pipeline skips them. Existing rule
 * headers (Nitro's own `cache-control`, the application's) win.
 */
export function applyNodeRouteRules(nitro: NitroLike, config: ResolvedConfig, assetPrefixes: string[]): void {
  if (targetForNitroPreset(nitro.options.preset) !== 'node') return;
  const rules = staticHeaderRules({
    config,
    manifest: emptyManifest(),
    documents: [],
    immutablePrefixes: assetPrefixes,
  });
  for (const [pattern, rule] of Object.entries(nodeRouteRules(rules))) {
    const current = nitro.options.routeRules[pattern] ?? {};
    // An application that switched the headers of this pattern off (`headers: false`) keeps it that way.
    if (current.headers === false) continue;
    nitro.options.routeRules[pattern] = { ...current, headers: { ...rule.headers, ...current.headers } };
  }
}

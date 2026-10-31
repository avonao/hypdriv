import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RouteAssetSources } from '@hypdriv/build';
import { assetsForEntries, entriesForSources, type ViteManifest } from '@hypdriv/vite';

/**
 * Reads the client manifest Nuxt's Vite builder writes for the SSR renderer (`<buildDir>/dist/server/client.manifest.mjs`,
 * a Vite manifest keyed by source paths relative to `srcDir`). Returns null when the build has none (SPA builds,
 * other builders).
 */
export async function readNuxtClientManifest(buildDir: string): Promise<ViteManifest | null> {
  const json = join(buildDir, 'dist', 'server', 'client.manifest.json');
  if (existsSync(json)) {
    try {
      return JSON.parse(readFileSync(json, 'utf8')) as ViteManifest;
    } catch {
      return null;
    }
  }
  const mjs = join(buildDir, 'dist', 'server', 'client.manifest.mjs');
  if (!existsSync(mjs)) return null;
  try {
    // The build's own output; the query defeats the module cache across builds in one process.
    const url = `${pathToFileURL(mjs).href}?t=${statSync(mjs).mtimeMs}`;
    const mod = (await import(/* @vite-ignore */ url)) as { default?: ViteManifest };
    return mod.default && typeof mod.default === 'object' ? mod.default : null;
  } catch {
    return null;
  }
}

/** Keys of the manifest's entry chunks (Nuxt's app entry: every page loads it). */
export function entryKeys(manifest: ViteManifest): string[] {
  return Object.entries(manifest)
    .filter(([, chunk]) => chunk.isEntry)
    .map(([key]) => key);
}

/**
 * The client assets of a page component: its chunk, the chunks it imports statically (the app entry included) and
 * their CSS and fonts. `base` is the public path of the build assets (`/_nuxt/`).
 */
export function pageAssets(
  manifest: ViteManifest,
  input: { srcDir: string; file: string; base: string },
): RouteAssetSources | undefined {
  const key = relative(input.srcDir, input.file).replace(/\\/g, '/');
  const keys = entriesForSources(manifest, [key]);
  if (!keys.length) return undefined;
  return assetsForEntries(manifest, keys, input.base);
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteAssetSources } from '@hypdriv/build';

/** One entry of Vite's build manifest (`.vite/manifest.json`). */
export interface ViteManifestChunk {
  src?: string;
  file: string;
  css?: string[];
  assets?: string[];
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  name?: string;
  imports?: string[];
  dynamicImports?: string[];
}

export type ViteManifest = Record<string, ViteManifestChunk>;

/** Reads `<outDir>/.vite/manifest.json` (or a custom manifest path); null when absent or unreadable. */
export function readViteManifest(outDir: string, file = join('.vite', 'manifest.json')): ViteManifest | null {
  const path = join(outDir, file);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ViteManifest;
  } catch {
    return null;
  }
}

function publicPath(base: string, file: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${file.replace(/^\/+/, '')}`;
}

const FONT = /\.(?:woff2?|ttf|otf|eot)$/i;

/**
 * Client assets of one or more manifest entries: the entry chunks (preload candidates), every statically
 * imported chunk (transitively), their CSS, and font assets. Dynamic imports are not followed — they load on
 * demand and must not be preloaded.
 */
export function assetsForEntries(manifest: ViteManifest, keys: string[], base = '/'): RouteAssetSources {
  const js: string[] = [];
  const css: string[] = [];
  const fonts: string[] = [];
  const main: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string, entry: boolean) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return;
    if (chunk.file.endsWith('.js') || chunk.file.endsWith('.mjs')) {
      const href = publicPath(base, chunk.file);
      js.push(href);
      if (entry) main.push(href);
    } else if (chunk.file.endsWith('.css')) css.push(publicPath(base, chunk.file));
    for (const c of chunk.css ?? []) css.push(publicPath(base, c));
    for (const a of chunk.assets ?? []) if (FONT.test(a)) fonts.push(publicPath(base, a));
    for (const i of chunk.imports ?? []) visit(i, false);
  };
  for (const key of keys) visit(key, true);
  return { js: [...new Set(js)], css: [...new Set(css)], fonts: [...new Set(fonts)], main };
}

/** Finds manifest keys whose `src` (or key) matches one of the given source files (project-relative). */
export function entriesForSources(manifest: ViteManifest, sources: string[]): string[] {
  const wanted = new Set(sources.map((s) => s.replace(/^\.\//, '').replace(/\\/g, '/')));
  return Object.entries(manifest)
    .filter(([key, chunk]) => wanted.has(key) || (chunk.src !== undefined && wanted.has(chunk.src)))
    .map(([key]) => key);
}

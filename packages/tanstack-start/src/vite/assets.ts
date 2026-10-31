import { resolve } from 'node:path';
import type { RouteAssetSources } from '@hypdriv/build';

/** One chunk of the client build, reduced to what per-route assets need. */
export interface ClientChunk {
  fileName: string;
  isEntry: boolean;
  /** Statically imported chunks (file names). */
  imports: string[];
  /** CSS files the chunk's modules import (`viteMetadata.importedCss`) or reference by URL (`?url`). */
  css: string[];
  /** Route files (absolute) whose code-split pieces (`?tsr-split=…`) the chunk holds. */
  routeFiles: string[];
}

/** The parts of a Rolldown output chunk this module reads. */
export interface OutputChunkLike {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  imports?: string[];
  moduleIds?: string[];
  viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> };
}

const SPLIT_QUERY = 'tsr-split';

/**
 * Reduces the client bundle to its chunks: entries, static imports, CSS, and which route files each code-split
 * chunk belongs to (TanStack's code splitter loads `src/routes/about.tsx?tsr-split=component` as its own chunk).
 */
export function clientChunksFrom(bundle: Record<string, OutputChunkLike>): ClientChunk[] {
  const chunks: ClientChunk[] = [];
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    const routeFiles = new Set<string>();
    for (const id of output.moduleIds ?? []) {
      const q = id.indexOf('?');
      if (q < 0) continue;
      if (!new URLSearchParams(id.slice(q + 1)).has(SPLIT_QUERY)) continue;
      routeFiles.add(resolve(id.slice(0, q).replace(/^\0/, '')));
    }
    const css = new Set<string>(output.viteMetadata?.importedCss ?? []);
    for (const asset of output.viteMetadata?.importedAssets ?? []) if (asset.endsWith('.css')) css.add(asset);
    chunks.push({
      fileName: output.fileName,
      isEntry: output.isEntry === true,
      imports: [...(output.imports ?? [])],
      css: [...css],
      routeFiles: [...routeFiles],
    });
  }
  return chunks;
}

function publicPath(base: string, file: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${file.replace(/^\/+/, '')}`;
}

/**
 * The client assets a page loads: the entry chunks with their static imports (shared by every page) and the
 * code-split chunks of the route's files (its own and its layouts'), with their static imports and CSS. Lazily
 * imported chunks are left out: they load on demand and must not be preloaded.
 */
export function routeSources(chunks: ClientChunk[], files: string[], base = '/'): RouteAssetSources {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const wanted = new Set(files.map((f) => resolve(f)));
  const js: string[] = [];
  const css: string[] = [];
  const main: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string, entry: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = byName.get(name);
    if (!chunk) return;
    const href = publicPath(base, chunk.fileName);
    js.push(href);
    if (entry) main.push(href);
    for (const c of chunk.css) css.push(publicPath(base, c));
    for (const i of chunk.imports) visit(i, false);
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk.fileName, true);
  for (const chunk of chunks) if (chunk.routeFiles.some((f) => wanted.has(f))) visit(chunk.fileName, false);
  return { js: [...new Set(js)], css: [...new Set(css)], fonts: [], main };
}

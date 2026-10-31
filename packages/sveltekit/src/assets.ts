import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteAssetSources } from '@hypdriv/build';

/** The client entry SvelteKit's server manifest records (`client` in `manifest-full.js`). */
interface ClientEntry {
  start: string | null;
  app: string | null;
  imports: string[];
  stylesheets: string[];
  fonts: string[];
}

interface NodeAssets {
  imports: string[];
  stylesheets: string[];
  fonts: string[];
}

function parseStringArray(source: string | undefined): string[] {
  if (!source) return [];
  try {
    const value = JSON.parse(`[${source}]`) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseString(source: string | undefined): string | null {
  if (!source) return null;
  try {
    const value = JSON.parse(source) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Reads the `client` entry of SvelteKit's generated server manifest. */
export function parseClientEntry(manifestSource: string): ClientEntry | null {
  const block = /\bclient:\s*\{([^}]*)\}/.exec(manifestSource)?.[1];
  if (!block) return null;
  return {
    start: parseString(/\bstart:\s*("(?:[^"\\]|\\.)*")/.exec(block)?.[1]),
    app: parseString(/\bapp:\s*("(?:[^"\\]|\\.)*")/.exec(block)?.[1]),
    imports: parseStringArray(/\bimports:\s*\[([^\]]*)\]/.exec(block)?.[1]),
    stylesheets: parseStringArray(/\bstylesheets:\s*\[([^\]]*)\]/.exec(block)?.[1]),
    fonts: parseStringArray(/\bfonts:\s*\[([^\]]*)\]/.exec(block)?.[1]),
  };
}

/** Route id → the node indexes of its page (layouts, error boundaries are not loaded up front, leaf). */
export function parseRouteNodes(manifestSource: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const route =
    /\bid:\s*("(?:[^"\\]|\\.)*")\s*,[\s\S]*?\bpage:\s*(null|\{\s*layouts:\s*\[([^\]]*)\]\s*,\s*errors:\s*\[[^\]]*\]\s*,\s*leaf:\s*(\d+)\s*\})/g;
  for (const m of manifestSource.matchAll(route)) {
    const id = parseString(m[1]);
    if (!id || m[2] === 'null') continue;
    const layouts = (m[3] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    out.set(id, [...layouts, Number(m[4])]);
  }
  return out;
}

/** The `imports` / `stylesheets` / `fonts` a generated server node (`nodes/<n>.js`) exports. */
export function parseNodeAssets(source: string): NodeAssets {
  const list = (name: string) =>
    parseStringArray(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source)?.[1]);
  return { imports: list('imports'), stylesheets: list('stylesheets'), fonts: list('fonts') };
}

const FONT = /\.(?:woff2?|ttf|otf|eot)$/i;

/**
 * Client assets per route id, read from SvelteKit's server output (`manifest-full.js` and `nodes/*.js`, parsed as
 * text: importing them would evaluate server code): the client entry (`start`, `app` and their imports) plus the
 * JavaScript, CSS and fonts of the route's layouts and page. `prefix` is the public base of the files (`paths.assets`
 * or `paths.base`). Returns an empty map when the output has an unexpected shape.
 */
export function routeAssets(serverDir: string, prefix: string): Map<string, RouteAssetSources> {
  const out = new Map<string, RouteAssetSources>();
  const manifestFile = join(serverDir, 'manifest-full.js');
  if (!existsSync(manifestFile)) return out;
  let manifestSource: string;
  try {
    manifestSource = readFileSync(manifestFile, 'utf8');
  } catch {
    return out;
  }
  const base = prefix.replace(/\/+$/, '');
  const href = (file: string) => (/^[a-z]+:\/\//i.test(file) ? file : `${base}/${file.replace(/^\/+/, '')}`);
  const client = parseClientEntry(manifestSource);
  const nodeCache = new Map<number, NodeAssets>();
  const nodeAssets = (index: number): NodeAssets => {
    const cached = nodeCache.get(index);
    if (cached) return cached;
    let assets: NodeAssets = { imports: [], stylesheets: [], fonts: [] };
    try {
      assets = parseNodeAssets(readFileSync(join(serverDir, 'nodes', `${index}.js`), 'utf8'));
    } catch {
      // node file missing: no assets
    }
    nodeCache.set(index, assets);
    return assets;
  };
  for (const [id, nodes] of parseRouteNodes(manifestSource)) {
    const js = new Set<string>();
    const css = new Set<string>();
    const fonts = new Set<string>();
    const main: string[] = [];
    if (client) {
      for (const f of [client.start, client.app]) if (f) main.push(href(f));
      for (const f of client.imports) js.add(href(f));
      for (const f of client.stylesheets) css.add(href(f));
      for (const f of client.fonts) fonts.add(href(f));
    }
    for (const index of nodes) {
      const assets = nodeAssets(index);
      for (const f of assets.imports) js.add(href(f));
      for (const f of assets.stylesheets) css.add(href(f));
      for (const f of assets.fonts) if (FONT.test(f)) fonts.add(href(f));
    }
    // The page's own node is an entry of the route as well.
    const leaf = nodes[nodes.length - 1];
    if (leaf !== undefined) {
      const first = nodeAssets(leaf).imports[0];
      if (first) main.push(href(first));
    }
    out.set(id, { js: [...js], css: [...css], fonts: [...fonts], main: [...new Set(main)] });
  }
  return out;
}

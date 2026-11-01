import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteAssetSources } from '@hypdriv/build';
import type { HypManifest, Logger, ManifestFramework, ResolvedConfig } from '@hypdriv/core';
import {
  assetsForEntries,
  type DiscoveredRoute,
  type FinalizeResult,
  finalizeManifest,
  MANIFEST_SENTINEL_VALUE,
  normalizePathname,
  type PrerenderedDocument,
  patchRuntimeManifest,
  replaceRuntimeManifest,
  rulesFor,
  type ViteManifest,
  writeCloudflareStatic,
  writeVercelStatic,
} from '@hypdriv/vite';
import type { NitroTarget } from './targets';

/** A route Nitro prerendered (`prerender:generate` / `prerender:done`). */
export interface PrerenderedRoute {
  route: string;
  fileName?: string;
  contentType?: string;
  error?: unknown;
  skip?: boolean;
}

/** Fallback documents the static presets emit; never navigated to directly. */
export const NITRO_INTERNAL_PAGES = ['/200.html', '/404.html'];

/** The HTML documents among Nitro's prerendered routes, by URL path (`/about`), with their files in `publicDir`. */
export function prerenderedDocuments(routes: PrerenderedRoute[], publicDir: string): PrerenderedDocument[] {
  const out = new Map<string, PrerenderedDocument>();
  for (const route of routes) {
    if (route.error || route.skip || !route.fileName) continue;
    const html = route.fileName.endsWith('.html') || (route.contentType ?? '').includes('text/html');
    if (!html) continue;
    let fileName = route.fileName;
    try {
      fileName = decodeURI(route.fileName);
    } catch {
      // keep the encoded name
    }
    const pathname = normalizePathname(route.route.split('?')[0] ?? '/');
    out.set(pathname, { pathname, file: join(publicDir, fileName) });
  }
  return [...out.values()];
}

/** Keys of the manifest's entry chunks (the app entry: every page loads it). */
export function entryKeys(manifest: ViteManifest): string[] {
  return Object.entries(manifest)
    .filter(([, chunk]) => chunk.isEntry)
    .map(([key]) => key);
}

export function mergeSources(a: RouteAssetSources, b: RouteAssetSources | undefined): RouteAssetSources {
  if (!b) return a;
  const merge = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    js: merge(a.js, b.js),
    css: merge(a.css, b.css),
    fonts: merge(a.fonts, b.fonts),
    main: merge(a.main, b.main),
  };
}

/**
 * Attaches the client assets every page loads (the entry chunks of the Vite client build, their CSS and fonts) to
 * page routes; a framework integration refines this per page through `FinalizeNitroInput.pageAssets`.
 */
export function withSharedAssets(
  routes: DiscoveredRoute[],
  manifest: ViteManifest | null,
  base: string,
  pageAssets?: (route: DiscoveredRoute, manifest: ViteManifest) => RouteAssetSources | undefined,
): DiscoveredRoute[] {
  if (!manifest) return routes;
  const shared = assetsForEntries(manifest, entryKeys(manifest), base);
  return routes.map((route) => {
    if (route.kind !== 'page') return route;
    return { ...route, sources: mergeSources(shared, pageAssets?.(route, manifest)) };
  });
}

export interface FinalizeNitroInput {
  rootDir: string;
  config: ResolvedConfig;
  framework: ManifestFramework;
  /** The framework's build id, when it has one. */
  buildId?: string;
  /** The application's base URL (`/`). */
  baseURL: string;
  routes: DiscoveredRoute[];
  prerendered: PrerenderedRoute[];
  /** Nitro's public output directory (prerendered documents and build assets). */
  publicDir: string;
  /** The Vite client build's manifest (`.vite/manifest.json`), when the application has a Vite client build. */
  clientManifest: ViteManifest | null;
  /** Public path the client output directory is served from, when it is not `baseURL`. */
  clientBase?: string;
  /** Public path prefixes of immutable build assets (`/assets/`). */
  assetPrefixes: string[];
  /** Pages never navigated to directly (error documents, fallbacks). */
  internalPages?: string[];
  /** Per-page client assets on top of the shared entry assets. */
  pageAssets?: (route: DiscoveredRoute, manifest: ViteManifest) => RouteAssetSources | undefined;
  log?: Logger;
}

/**
 * Builds the Hypdriv manifest of a Nitro build: pages and server routes, client assets per page, the prerendered
 * documents (CSP hashes, Early Hints) and the build checks (budgets, Purser, secrets). Writes `.hypdriv/`.
 */
export async function finalizeNitroManifest(input: FinalizeNitroInput): Promise<FinalizeResult> {
  // The files of a Vite client manifest are relative to the client output directory (`assets/app-3f2a.js`), which is
  // served from the application's base URL; `clientBase` is for builds that serve it elsewhere.
  const routes = withSharedAssets(
    input.routes,
    input.clientManifest,
    input.clientBase ?? input.baseURL,
    input.pageAssets,
  );
  return finalizeManifest({
    root: input.rootDir,
    config: input.config,
    framework: input.framework,
    ...(input.buildId ? { buildId: input.buildId } : {}),
    base: input.baseURL,
    routes,
    documents: prerenderedDocuments(input.prerendered, input.publicDir),
    clientDir: input.publicDir,
    immutablePrefixes: input.assetPrefixes,
    internalPages: [...NITRO_INTERNAL_PAGES, ...(input.internalPages ?? [])],
    ...(input.log ? { log: input.log } : {}),
  });
}

/** Throws when the manifest checks found problems that must fail the build. */
export function assertFinalized(result: FinalizeResult): void {
  if (result.failures.length)
    throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
}

export interface NitroOutputInput {
  target: NitroTarget;
  config: ResolvedConfig;
  result: FinalizeResult;
  /** Nitro's `output.publicDir` (Cloudflare's assets directory, Vercel's `static/`). */
  publicDir: string;
  /** Nitro's `output.dir` (`.output`, `.vercel/output`). */
  outputDir: string;
  /** Nitro's `output.serverDir` (the server bundle; Vercel's `functions/__server.func`). */
  serverDir: string;
  /** Write the platform's static header configuration (default true). */
  staticHeaders?: boolean;
  log?: Logger;
}

export interface NitroOutputResult {
  /** Server files whose embedded manifest was replaced with the final one. */
  patched: string[];
  /** Server files that embed the final manifest (patched or already built with it). */
  embedded: string[];
  /** The static header file written (`_headers`, `config.json`), if any. */
  headersFile: string | null;
}

/**
 * Completes the platform output once Nitro wrote it: the final manifest goes into every server file that embeds the
 * runtime manifest, and the static header rules (security headers, the hash CSP of each prerendered document,
 * Early Hints) go into Cloudflare's `_headers` or Vercel's Build Output `config.json`. Node serves every document
 * through Nitro, where the pipeline applies them at run time. Build-asset caching stays Nitro's (`publicAssets`
 * `maxAge` emits the immutable rules itself).
 */
export function completeNitroOutput(input: NitroOutputInput): NitroOutputResult {
  const { manifest } = input.result;
  const dirs = serverDirs(input);
  const patched = patchRuntimeManifest(dirs, manifest as HypManifest);
  const embedded = runtimeManifestFiles(dirs, manifest as HypManifest);
  if (embedded.stale.length)
    throw new Error(
      `hypdriv: the final manifest could not be written into ${embedded.stale.join(', ')}; the server would run with a stale manifest`,
    );
  let headersFile: string | null = null;
  if (input.staticHeaders !== false && input.target !== 'node') {
    const rules = rulesFor({
      config: input.config,
      manifest,
      documents: input.result.documents,
      immutablePrefixes: [],
    });
    if (input.target === 'cloudflare')
      headersFile = writeCloudflareStatic({
        assetsDir: input.publicDir,
        rules,
        ...(input.log ? { log: input.log } : {}),
      }).file;
    else
      headersFile = writeVercelStatic({
        outputDir: input.outputDir,
        rules,
        ...(input.log ? { log: input.log } : {}),
      }).file;
  }
  return { patched, embedded: embedded.current, headersFile };
}

/**
 * The built server files that embed Hypdriv's runtime manifest, split into those carrying `manifest` and those
 * carrying another one.
 */
export function runtimeManifestFiles(
  dirs: string[],
  manifest: HypManifest,
): { current: string[]; stale: string[] } {
  const current: string[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' && !dir.endsWith('.func')) continue;
        walk(full);
        continue;
      }
      if (!/\.(?:m?js|cjs)$/.test(entry.name) || seen.has(full)) continue;
      seen.add(full);
      let code: string;
      try {
        code = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!code.includes(MANIFEST_SENTINEL_VALUE)) continue;
      const next = replaceRuntimeManifest(code, manifest);
      // The value can appear without the embedded literal (a comment, a string elsewhere).
      if (next === null) continue;
      (next === code ? current : stale).push(full);
    }
  };
  for (const dir of dirs) walk(dir);
  return { current, stale };
}

function serverDirs(input: NitroOutputInput): string[] {
  const dirs = new Set([input.serverDir]);
  // Vercel: every non-symlinked function directory (ISR and per-route functions are symlinks to the main one).
  if (input.target === 'vercel') dirs.add(join(input.outputDir, 'functions'));
  return [...dirs];
}

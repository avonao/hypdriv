import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { entryKeys, pageAssets } from './client-manifest';
import type { NuxtTarget } from './targets';

/** A route Nitro prerendered (`prerender:generate` / `prerender:done`). */
export interface PrerenderedRoute {
  route: string;
  fileName?: string;
  contentType?: string;
  error?: unknown;
  skip?: boolean;
}

/** Pages never navigated to directly: Nuxt's error rendering and the static presets' fallback documents. */
export const NUXT_INTERNAL_PAGES = ['/404', '/500', '/__nuxt_error', '/200.html', '/404.html'];

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

function mergeSources(a: RouteAssetSources, b: RouteAssetSources | undefined): RouteAssetSources {
  if (!b) return a;
  const merge = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    js: merge(a.js, b.js),
    css: merge(a.css, b.css),
    fonts: merge(a.fonts, b.fonts),
    main: merge(a.main, b.main),
  };
}

/** Attaches client assets (the app entry plus the page's own chunk, CSS and fonts) to page routes. */
export function withPageAssets(
  routes: DiscoveredRoute[],
  input: { manifest: ViteManifest | null; rootDir: string; srcDir: string; buildAssetsPath: string },
): DiscoveredRoute[] {
  const manifest = input.manifest;
  if (!manifest) return routes;
  const shared = assetsForEntries(manifest, entryKeys(manifest), input.buildAssetsPath);
  return routes.map((route) => {
    if (route.kind !== 'page') return route;
    const own = route.sourcePage
      ? pageAssets(manifest, {
          srcDir: input.srcDir,
          file: resolve(input.rootDir, route.sourcePage),
          base: input.buildAssetsPath,
        })
      : undefined;
    return { ...route, sources: mergeSources(shared, own) };
  });
}

export interface FinalizeNuxtInput {
  rootDir: string;
  srcDir: string;
  config: ResolvedConfig;
  framework: ManifestFramework;
  /** Nuxt's build id (`app.buildId`, also in `/_nuxt/builds/meta/<id>.json`). */
  buildId?: string;
  /** `app.baseURL`. */
  baseURL: string;
  /** `app.baseURL` + `app.buildAssetsDir` (`/_nuxt/`). */
  buildAssetsPath: string;
  routes: DiscoveredRoute[];
  prerendered: PrerenderedRoute[];
  /** Nitro's public output directory (prerendered documents and build assets). */
  publicDir: string;
  clientManifest: ViteManifest | null;
  log?: Logger;
}

/**
 * Builds the Hypdriv manifest of a Nuxt build: pages and server routes, client assets per page, the prerendered
 * documents (CSP hashes, Early Hints) and the build checks (budgets, Purser, secrets). Writes `.hypdriv/`.
 */
export async function finalizeNuxtManifest(input: FinalizeNuxtInput): Promise<FinalizeResult> {
  const routes = withPageAssets(input.routes, {
    manifest: input.clientManifest,
    rootDir: input.rootDir,
    srcDir: input.srcDir,
    buildAssetsPath: input.buildAssetsPath,
  });
  return finalizeManifest({
    root: input.rootDir,
    config: input.config,
    framework: input.framework,
    ...(input.buildId ? { buildId: input.buildId } : {}),
    base: input.baseURL,
    routes,
    documents: prerenderedDocuments(input.prerendered, input.publicDir),
    clientDir: input.publicDir,
    immutablePrefixes: [input.buildAssetsPath],
    internalPages: NUXT_INTERNAL_PAGES,
    ...(input.log ? { log: input.log } : {}),
  });
}

/** Throws when the manifest checks found problems that must fail the build. */
export function assertFinalized(result: FinalizeResult): void {
  if (result.failures.length)
    throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
}

export interface NuxtOutputInput {
  target: NuxtTarget;
  config: ResolvedConfig;
  result: FinalizeResult;
  /** Nitro's `output.publicDir` (Cloudflare's assets directory, Vercel's `static/`). */
  publicDir: string;
  /** Nitro's `output.dir` (`.output`, `.vercel/output`). */
  outputDir: string;
  /** Nitro's `output.serverDir` (the server bundle; Vercel's `functions/__fallback.func`). */
  serverDir: string;
  /** Write the platform's static header configuration (default true). */
  staticHeaders?: boolean;
  log?: Logger;
}

export interface NuxtOutputResult {
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
 * `maxAge` emits the immutable rules for `/_nuxt/*` itself).
 */
export function completeNuxtOutput(input: NuxtOutputInput): NuxtOutputResult {
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

function serverDirs(input: NuxtOutputInput): string[] {
  const dirs = new Set([input.serverDir]);
  // Vercel: every non-symlinked function directory (ISR and per-route functions are symlinks to `__fallback`).
  if (input.target === 'vercel') dirs.add(join(input.outputDir, 'functions'));
  return [...dirs];
}

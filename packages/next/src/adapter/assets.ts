import { join } from 'node:path';
import type { AdapterFs } from './fs';
import { extractAssets } from './html';

export interface RouteAssetSources {
  js: string[];
  css: string[];
  fonts: string[];
  /** Entry chunks that bootstrap the route (preload candidates). */
  main: string[];
}

function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** `static/chunks/x.js` → `/_next/static/chunks/x.js` (honouring basePath). */
export function toPublicAssetPath(file: string, basePath = ''): string {
  if (file.startsWith('/') || file.startsWith('http')) return file;
  return `${basePath}/_next/${file.replace(/^\/+/, '')}`;
}

/** Parses `globalThis.__RSC_MANIFEST["/page"] = {...}` client reference manifests. */
export function parseClientReferenceManifest(source: string): { entryCSSFiles: string[]; entryJSFiles: string[] } | null {
  const idx = source.indexOf('__RSC_MANIFEST[');
  if (idx === -1) return null;
  const eq = source.indexOf('=', source.indexOf(']', idx));
  if (eq === -1) return null;
  const start = source.indexOf('{', eq);
  if (start === -1) return null;
  // The manifest is a single JSON object literal; find its end by brace matching (strings aware).
  let depth = 0;
  let inString: string | null = null;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  let parsed: { entryCSSFiles?: Record<string, Array<string | { path: string; inlined?: boolean }>>; entryJSFiles?: Record<string, string[]> };
  try {
    parsed = JSON.parse(source.slice(start, end));
  } catch {
    return null;
  }
  const css: string[] = [];
  for (const files of Object.values(parsed.entryCSSFiles ?? {})) {
    for (const f of files) {
      const path = typeof f === 'string' ? f : f.inlined ? null : f.path;
      if (path && !css.includes(path)) css.push(path);
    }
  }
  const js: string[] = [];
  for (const files of Object.values(parsed.entryJSFiles ?? {})) for (const f of files) if (!js.includes(f)) js.push(f);
  return { entryCSSFiles: css, entryJSFiles: js };
}

interface BuildManifestLike {
  rootMainFiles?: string[];
  polyfillFiles?: string[];
  pages?: Record<string, string[]>;
  pagesChunkGroupBootstrapParams?: Record<string, { otherChunks?: string[] }>;
}

function readJson<T>(fs: AdapterFs, path: string): T | null {
  if (!fs.exists(path)) return null;
  try {
    return JSON.parse(fs.readText(path)) as T;
  } catch {
    return null;
  }
}

/**
 * Client assets for an App Router entry (`sourcePage` like `/blog/[slug]/page`) from the per-route
 * manifests Next.js 16 writes under `.next/server/app/<entry>/`.
 */
export function appRouteAssets(distDir: string, sourcePage: string, fs: AdapterFs, basePath = ''): RouteAssetSources {
  const entryDir = join(distDir, 'server', 'app', sourcePage.replace(/^\//, ''));
  const buildManifest = readJson<BuildManifestLike>(fs, join(entryDir, 'build-manifest.json')) ?? readJson<BuildManifestLike>(fs, join(distDir, 'build-manifest.json'));
  const crmPath = join(distDir, 'server', 'app', `${sourcePage.replace(/^\//, '')}_client-reference-manifest.js`);
  const crm = fs.exists(crmPath) ? parseClientReferenceManifest(fs.readText(crmPath)) : null;
  const main = uniq([...(buildManifest?.rootMainFiles ?? []), ...(buildManifest?.pagesChunkGroupBootstrapParams?.[sourcePage]?.otherChunks ?? [])]);
  const js = uniq([...main, ...(crm?.entryJSFiles ?? []), ...(buildManifest?.polyfillFiles ?? [])]);
  const css = uniq(crm?.entryCSSFiles ?? []);
  const fontManifest = readJson<{ app?: Record<string, string[]> }>(fs, join(entryDir, 'next-font-manifest.json')) ?? readJson<{ app?: Record<string, string[]> }>(fs, join(distDir, 'server', 'next-font-manifest.json'));
  const fonts = uniq(Object.values(fontManifest?.app ?? {}).flat());
  return {
    js: js.map((f) => toPublicAssetPath(f, basePath)),
    css: css.map((f) => toPublicAssetPath(f, basePath)),
    fonts: fonts.map((f) => toPublicAssetPath(f, basePath)),
    main: main.map((f) => toPublicAssetPath(f, basePath)),
  };
}

/** Client assets for a Pages Router page from `.next/build-manifest.json`. */
export function pagesRouteAssets(distDir: string, page: string, fs: AdapterFs, basePath = ''): RouteAssetSources {
  const buildManifest = readJson<BuildManifestLike>(fs, join(distDir, 'build-manifest.json'));
  const files = buildManifest?.pages?.[page] ?? [];
  const app = buildManifest?.pages?.['/_app'] ?? [];
  const js = uniq([...app, ...files].filter((f) => f.endsWith('.js')));
  const css = uniq([...app, ...files].filter((f) => f.endsWith('.css')));
  const fontManifest = readJson<{ pages?: Record<string, string[]> }>(fs, join(distDir, 'server', 'next-font-manifest.json'));
  const fonts = uniq(Object.values(fontManifest?.pages ?? {}).flat());
  return {
    js: js.map((f) => toPublicAssetPath(f, basePath)),
    css: css.map((f) => toPublicAssetPath(f, basePath)),
    fonts: fonts.map((f) => toPublicAssetPath(f, basePath)),
    main: js.map((f) => toPublicAssetPath(f, basePath)),
  };
}

/** Merges manifest-derived assets with what the prerendered HTML actually references (HTML wins for order). */
export function mergeWithHtml(sources: RouteAssetSources, html: string | null): RouteAssetSources {
  if (!html) return sources;
  const fromHtml = extractAssets(html);
  const js = uniq([...fromHtml.scripts, ...fromHtml.modulePreloads, ...fromHtml.preloads.filter((p) => p.as === 'script').map((p) => p.href), ...sources.js]);
  const css = uniq([...fromHtml.stylesheets, ...fromHtml.preloads.filter((p) => p.as === 'style').map((p) => p.href), ...sources.css]);
  const fonts = uniq([...fromHtml.fonts.map((f) => f.href), ...sources.fonts]);
  return { js, css, fonts, main: sources.main.length ? sources.main : js.slice(0, 4) };
}

/** Resolves a public `/_next/static/...` path to its file under distDir (null when not local). */
export function assetFilePath(distDir: string, publicPath: string, basePath = ''): string | null {
  const prefix = `${basePath}/_next/`;
  if (!publicPath.startsWith(prefix)) return null;
  return join(distDir, publicPath.slice(prefix.length).split('?')[0]!);
}

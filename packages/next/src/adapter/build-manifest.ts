import { join } from 'node:path';
import {
  assembleManifest,
  type BuildManifestResult,
  buildFingerprint,
  type ManifestRouteInput,
  type PurserVerifier,
  type PurserVerifierInput,
  type PurserVerifierResult,
  type SecretsScanner,
} from '@hypdriv/build';
import type { Logger, ResolvedConfig } from '@hypdriv/core';
import { appRouteAssets, assetFilePath, pagesRouteAssets, type RouteAssetSources } from './assets';
import { classifyOutputs, staticFileRoutes } from './classify';
import type { AdapterFs } from './fs';
import type { OnBuildCompleteContext } from './types';

export type {
  BuildManifestResult,
  PurserVerifier,
  PurserVerifierInput,
  PurserVerifierResult,
  SecretsScanner,
};
export { buildFingerprint };

export interface BuildManifestInput {
  context: OnBuildCompleteContext;
  config: ResolvedConfig;
  fs: AdapterFs;
  hypdrivVersion: string;
  log?: Logger;
  /** Purser verification hook (injected by the adapter when the bridge is available). */
  purser?: PurserVerifier;
  secrets?: SecretsScanner;
  /** The bundler that built the app (`turbopack` / `webpack`), recorded in `manifest.framework`. */
  bundler?: string;
  /** Limits the number of concrete prerendered HTML files read per dynamic route (default 25). */
  maxConcretePerRoute?: number;
  now?: () => Date;
}

function readHtml(fs: AdapterFs, file: string | undefined, max = 2 * 1024 * 1024): string | null {
  if (!file || !fs.exists(file)) return null;
  try {
    if (fs.size(file) > max) return null;
    return fs.readText(file);
  } catch {
    return null;
  }
}

/** Framework error boundaries that are never navigated to directly. */
const INTERNAL_PAGES = new Set(['/_global-error', '/_error', '/_app', '/_document']);

/**
 * Prerendered documents by pathname (HTML plus the full-route RSC payload), read from the files the
 * adapter outputs point at. Segment payloads (`.segments/`) are skipped: the full payload covers them.
 */
export function collectDocuments(
  context: OnBuildCompleteContext,
  fs: AdapterFs,
  limits: { maxFiles?: number; maxBytes?: number } = {},
): Record<string, string> {
  const maxFiles = limits.maxFiles ?? 4000;
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024;
  const rscSuffix = context.routing.rsc?.suffix ?? '.rsc';
  const out: Record<string, string> = {};
  let files = 0;
  const add = (pathname: string, text: string) => {
    out[pathname] = out[pathname] ? `${out[pathname]}\n${text}` : text;
  };
  for (const p of context.outputs.prerenders ?? []) {
    const file = p.fallback?.filePath;
    if (!file || files >= maxFiles || p.pathname.includes('.segments/')) continue;
    const isHtml = file.endsWith('.html');
    const isRsc = !isHtml && p.pathname.endsWith(rscSuffix);
    if (!isHtml && !isRsc) continue;
    let pathname = isRsc ? p.pathname.slice(0, -rscSuffix.length) : p.pathname;
    if (pathname === '/index' || pathname === '') pathname = '/';
    if (/\[[^\]]+\]/.test(pathname) && !isHtml) continue; // fallback shells of dynamic routes carry no concrete classes
    try {
      if (!fs.exists(file) || fs.size(file) > maxBytes) continue;
      add(pathname, fs.readText(file));
      files++;
    } catch {
      // unreadable output: skip
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Derives the Hypdriv manifest from a Next.js `onBuildComplete` context and the build directory. */
export async function buildManifest(input: BuildManifestInput): Promise<BuildManifestResult> {
  const { context, config, fs } = input;
  const basePath = context.config.basePath ?? '';
  const warnings: string[] = [];
  const classified = classifyOutputs(context.outputs, context.routing.rsc?.suffix ?? '.rsc');
  const statics = staticFileRoutes(context.outputs);
  const maxConcrete = input.maxConcretePerRoute ?? 25;

  const routes: ManifestRouteInput[] = [];
  for (const item of classified) {
    const { route, primaryPrerender, concretePrerenders, output } = item;
    const sources: RouteAssetSources =
      route.kind === 'app-page' || route.kind === 'app-route'
        ? appRouteAssets(context.distDir, output.sourcePage, fs, basePath)
        : pagesRouteAssets(context.distDir, output.sourcePage, fs, basePath);
    const isPage = route.kind === 'app-page' || route.kind === 'page';
    // Prerendered HTML: the primary output, or the first concrete path for dynamic routes.
    const htmlFile =
      primaryPrerender?.fallback?.filePath ??
      concretePrerenders.find((c) => c.fallback?.filePath)?.fallback?.filePath;
    const document = isPage ? readHtml(fs, htmlFile) : null;
    const concrete: Array<{ pathname: string; html: string }> = [];
    if (document) {
      for (const c of concretePrerenders.slice(0, maxConcrete)) {
        const d = readHtml(fs, c.fallback?.filePath);
        if (d && c.fallback?.filePath) concrete.push({ pathname: c.pathname, html: d });
      }
    }
    if (route.runtime === 'edge')
      warnings.push(
        `${route.pathname} uses the deprecated Edge runtime; OpenNext Cloudflare does not support it. Remove \`export const runtime = 'edge'\`.`,
      );
    routes.push({ route, sources, document, concrete });
  }

  // Deprecated middleware file name check.
  if (context.outputs.middleware) {
    const hasProxy = ['proxy.ts', 'proxy.js', 'proxy.mts', 'src/proxy.ts', 'src/proxy.js'].some((f) =>
      fs.exists(join(context.projectDir, f)),
    );
    const hasMiddleware = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'].some(
      (f) => fs.exists(join(context.projectDir, f)),
    );
    if (hasMiddleware && !hasProxy)
      warnings.push(
        'middleware.ts is deprecated in Next.js 16; rename it to proxy.ts (npx @next/codemod@canary middleware-to-proxy .).',
      );
  }

  return assembleManifest({
    config,
    framework: {
      name: 'next',
      version: context.nextVersion,
      ...(input.bundler ? { bundler: input.bundler } : {}),
    },
    buildId: context.buildId,
    ...(context.config.deploymentId ? { deploymentId: context.config.deploymentId } : {}),
    basePath,
    trailingSlash: context.config.trailingSlash ?? false,
    cacheComponents: context.config.cacheComponents === true,
    routes,
    staticFiles: {
      count: statics.count,
      immutablePrefixes: statics.immutablePrefixes,
      routes: statics.routes,
    },
    ...(context.outputs.middleware?.config.matchers
      ? {
          proxy: {
            matchers: context.outputs.middleware.config.matchers.map((m) => ({
              source: m.source,
              sourceRegex: m.sourceRegex,
              ...(m.has ? { has: redactPreviewModeId(m.has) } : {}),
              ...(m.missing ? { missing: redactPreviewModeId(m.missing) } : {}),
            })),
          },
        }
      : {}),
    projectDir: context.projectDir,
    distDir: context.distDir,
    clientDirs: [join(context.distDir, 'static'), join(context.projectDir, 'public')],
    assetFile: (publicPath) => assetFilePath(context.distDir, publicPath, basePath),
    fs,
    // Purser checks every prerendered document and RSC payload the outputs point at.
    ...(config.purser && input.purser ? { documents: collectDocuments(context, fs) } : {}),
    ...(input.purser ? { purser: input.purser } : {}),
    ...(input.secrets ? { secrets: input.secrets } : {}),
    hypdrivVersion: input.hypdrivVersion,
    ...(input.log ? { log: input.log } : {}),
    ...(input.now ? { now: input.now } : {}),
    warnings,
    revalidationToken: previewModeId(context, fs),
    internalPages: INTERNAL_PAGES,
  });
}

/** Placeholder for the preview-mode id in `x-prerender-revalidate` matcher conditions. */
export const PREVIEW_MODE_ID_PLACEHOLDER = '<preview-mode-id>';

/**
 * Next.js excludes its own revalidation requests from the proxy matcher with a `missing` condition that
 * carries the preview-mode id. The manifest keeps the condition but never the id.
 */
function redactPreviewModeId<T extends { type: string; key?: string; value?: string }>(conditions: T[]): T[] {
  return conditions.map((c) =>
    c.key?.toLowerCase() === 'x-prerender-revalidate' && c.value
      ? { ...c, value: PREVIEW_MODE_ID_PLACEHOLDER }
      : c,
  );
}

/**
 * The build's preview-mode id: the token Next.js accepts in `x-prerender-revalidate` to regenerate a
 * prerendered page (OpenNext's revalidation queue sends it). Taken from the prerender outputs'
 * `bypassToken`, else from `prerender-manifest.json`; `null` when the build has no prerenders.
 */
export function previewModeId(context: OnBuildCompleteContext, fs: AdapterFs): string | null {
  for (const p of context.outputs.prerenders ?? []) {
    const token = p.config?.bypassToken;
    if (typeof token === 'string' && token.length >= 16) return token;
  }
  const file = join(context.distDir, 'prerender-manifest.json');
  try {
    if (!fs.exists(file)) return null;
    const parsed = JSON.parse(fs.readText(file)) as { preview?: { previewModeId?: unknown } };
    const id = parsed.preview?.previewModeId;
    return typeof id === 'string' && id.length >= 16 ? id : null;
  } catch {
    return null;
  }
}

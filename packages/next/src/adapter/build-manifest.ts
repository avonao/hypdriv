import { join, relative } from 'node:path';
import {
  type BudgetResult,
  type HypManifest,
  type HypRoute,
  type Logger,
  MANIFEST_VERSION,
  type PurserManifest,
  type ResolvedConfig,
  cspHash,
  evaluateBudgets,
  matchesAny,
  silentLogger,
} from '@hypdriv/core';
import { linkEntriesForRoute, linkHeaderValues } from '../shared/hints';
import { type RouteAssetSources, appRouteAssets, assetFilePath, mergeWithHtml, pagesRouteAssets } from './assets';
import { type ClassifiedRoute, classifyOutputs, staticFileRoutes } from './classify';
import type { AdapterFs } from './fs';
import { extractInlineScripts, extractInlineStyles, extractLinks } from './html';
import type { OnBuildCompleteContext } from './types';

export interface PurserVerifierInput {
  /** Prerendered HTML by route id (primary documents only). */
  html: Record<string, string>;
  config: ResolvedConfig;
  projectDir: string;
  /** Next's dist directory (`.next`), for collecting every prerendered document and RSC payload. */
  distDir: string;
  /** Emitted client CSS files (public paths) across all routes. */
  cssAssets: string[];
  /** Reads an emitted asset by public path (null when missing). */
  readAsset: (publicPath: string) => string | null;
  log: Logger;
}

export interface PurserVerifierResult {
  manifest: PurserManifest | null;
  ok: boolean;
  warnings: string[];
  /** Problems that fail the build (missing atoms with `verify: 'error'`, missing stylesheet). */
  errors?: string[];
}

export interface PurserVerifier {
  (input: PurserVerifierInput): Promise<PurserVerifierResult>;
}

export interface SecretsScanner {
  (input: { dirs: string[]; config: ResolvedConfig; log: Logger }): Promise<{ findings: Array<{ id: string; file: string; line: number; severity: 'error' | 'warn'; snippet: string }>; ok: boolean }>;
}

export interface BuildManifestInput {
  context: OnBuildCompleteContext;
  config: ResolvedConfig;
  fs: AdapterFs;
  hypdrivVersion: string;
  log?: Logger;
  /** Purser verification hook (injected by the adapter when the bridge is available). */
  purser?: PurserVerifier;
  secrets?: SecretsScanner;
  /** Limits the number of concrete prerendered HTML files read per dynamic route (default 25). */
  maxConcretePerRoute?: number;
  now?: () => Date;
}

export interface BuildManifestResult {
  manifest: HypManifest;
  /** Build must fail (budgets with failOn error, Purser verify errors, secrets). */
  failures: string[];
  /** Prerendered HTML by route id (static/isr/shell), useful to callers. */
  html: Record<string, string>;
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

/** Derives the HypDriv manifest from a Next.js `onBuildComplete` context and the build directory. */
export async function buildManifest(input: BuildManifestInput): Promise<BuildManifestResult> {
  const { context, config, fs } = input;
  const log = input.log ?? silentLogger;
  const basePath = context.config.basePath ?? '';
  const trailingSlash = context.config.trailingSlash ?? false;
  const warnings: string[] = [];
  const failures: string[] = [];
  const classified = classifyOutputs(context.outputs, context.routing.rsc?.suffix ?? '.rsc');
  const statics = staticFileRoutes(context.outputs);
  const html: Record<string, string> = {};
  const earlyHints: HypManifest['earlyHints'] = {};
  const csp: HypManifest['csp'] = {};
  const graph: Record<string, string[]> = {};
  const clientWeights: Record<string, { js: number; css: number }> = {};
  const sizeCache = new Map<string, number>();
  const sizeOf = (publicPath: string): number => {
    const file = assetFilePath(context.distDir, publicPath, basePath);
    if (!file) return 0;
    const hit = sizeCache.get(file);
    if (hit !== undefined) return hit;
    let n = 0;
    try {
      n = fs.exists(file) ? fs.gzipSize(file) : 0;
    } catch {
      n = 0;
    }
    sizeCache.set(file, n);
    return n;
  };

  const routes: HypRoute[] = [];
  for (const item of classified) {
    const { route, primaryPrerender, concretePrerenders, output } = item;
    const sources: RouteAssetSources =
      route.kind === 'app-page' || route.kind === 'app-route'
        ? appRouteAssets(context.distDir, output.sourcePage, fs, basePath)
        : pagesRouteAssets(context.distDir, output.sourcePage, fs, basePath);

    // Prerendered HTML: the primary output, or the first concrete path for dynamic routes.
    const htmlFile = primaryPrerender?.fallback?.filePath ?? concretePrerenders.find((c) => c.fallback?.filePath)?.fallback?.filePath;
    const doc = route.kind === 'app-page' || route.kind === 'page' ? readHtml(fs, htmlFile) : null;
    const merged = mergeWithHtml(sources, doc);
    route.assets = { js: merged.js, css: merged.css, fonts: merged.fonts };

    if (doc) {
      html[route.id] = doc;
      // Speculation graph: links from the primary document plus a few concrete ones.
      const links = new Set(extractLinks(doc, { basePath }));
      const extra = concretePrerenders.slice(0, input.maxConcretePerRoute ?? 25);
      for (const c of extra) {
        const d = readHtml(fs, c.fallback?.filePath);
        if (!d) continue;
        for (const l of extractLinks(d, { basePath })) links.add(l);
        if (route.classification === 'static' && c.fallback?.filePath) {
          // Hash every concrete static page too; store under the concrete pathname.
          csp[`${route.id}#${c.pathname}`] = await hashesFor(d);
        }
      }
      graph[route.pathname] = [...links].filter((l) => l !== route.pathname);
      if (route.classification === 'static') csp[route.id] = await hashesFor(doc);
    }

    if (config.performance.earlyHints) {
      const entries = linkEntriesForRoute(route, config.performance.earlyHints, { main: merged.main });
      if (entries.length) earlyHints[route.id] = linkHeaderValues(entries);
    }

    if (route.kind === 'app-page' || route.kind === 'page') {
      clientWeights[route.id] = {
        js: route.assets.js.reduce((n, f) => n + sizeOf(f), 0),
        css: route.assets.css.reduce((n, f) => n + sizeOf(f), 0),
      };
    }
    if (route.runtime === 'edge') warnings.push(`${route.pathname} uses the deprecated Edge runtime; OpenNext Cloudflare does not support it. Remove \`export const runtime = 'edge'\`.`);
    routes.push(route);
  }

  // Deprecated middleware file name check.
  if (context.outputs.middleware) {
    const hasProxy = ['proxy.ts', 'proxy.js', 'proxy.mts', 'src/proxy.ts', 'src/proxy.js'].some((f) => fs.exists(join(context.projectDir, f)));
    const hasMiddleware = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'].some((f) => fs.exists(join(context.projectDir, f)));
    if (hasMiddleware && !hasProxy) warnings.push('middleware.ts is deprecated in Next.js 16; rename it to proxy.ts (npx @next/codemod@canary middleware-to-proxy .).');
  }

  // Purser verification.
  let purser: PurserManifest | undefined;
  if (config.purser && input.purser) {
    try {
      const cssAssets = [...new Set(routes.flatMap((r) => r.assets.css))].sort();
      const readAsset = (publicPath: string): string | null => {
        const file = assetFilePath(context.distDir, publicPath, basePath);
        if (!file || !fs.exists(file)) return null;
        try {
          return fs.readText(file);
        } catch {
          return null;
        }
      };
      const result = await input.purser({ html, config, projectDir: context.projectDir, distDir: context.distDir, cssAssets, readAsset, log });
      if (result.manifest) purser = result.manifest;
      warnings.push(...result.warnings);
      if (result.errors?.length) failures.push(...result.errors.map((e) => `Purser: ${e}`));
      if (!result.ok && !result.errors?.length) failures.push('Purser verification failed: prerendered HTML references atoms missing from the stylesheet (see warnings).');
      // The theme fallback script is inlined by the root layout; allow it on hash-mode (static) routes.
      if (purser?.themeScriptHash) {
        for (const entry of Object.values(csp)) if (!entry.scriptHashes.includes(purser.themeScriptHash)) entry.scriptHashes.push(purser.themeScriptHash);
      }
    } catch (err) {
      warnings.push(`Purser verification skipped: ${(err as Error).message}`);
    }
  }

  // Secrets scan over client assets.
  if (config.security.secretsScan && input.secrets) {
    try {
      const dirs = [join(context.distDir, 'static'), join(context.projectDir, 'public')].filter((d) => fs.exists(d));
      const result = await input.secrets({ dirs, config, log });
      for (const f of result.findings) {
        const line = `secret pattern ${f.id} in ${relative(context.projectDir, f.file)}:${f.line} (${f.snippet})`;
        if (f.severity === 'error') failures.push(line);
        else warnings.push(line);
      }
      if (!result.ok && config.security.secretsScan.failOnFinding) failures.push('Secrets scan found credential-like strings in client assets.');
    } catch (err) {
      warnings.push(`Secrets scan skipped: ${(err as Error).message}`);
    }
  }

  // Budgets (client side; worker budgets are evaluated by `hypdriv analyze`).
  const budgetInput = routes
    .filter((r) => r.kind === 'app-page' || r.kind === 'page')
    .map((r) => ({ id: r.id, pathname: r.pathname, js: clientWeights[r.id]?.js ?? 0, css: clientWeights[r.id]?.css ?? 0 }));
  const allJs = new Set<string>();
  for (const r of routes) for (const f of r.assets.js) allJs.add(f);
  const totalJs = [...allJs].reduce((n, f) => n + sizeOf(f), 0);
  const budgets: BudgetResult[] = evaluateBudgets(config.budgets, { routes: budgetInput, totalJs });
  const overBudget = budgets.filter((b) => b.status === 'error');
  if (overBudget.length && config.budgets.failOn === 'error') failures.push(`${overBudget.length} budget(s) exceeded: ${overBudget.map((b) => b.id).join(', ')}`);

  const manifest: HypManifest = {
    version: MANIFEST_VERSION,
    buildId: context.buildId,
    ...(context.config.deploymentId ? { deploymentId: context.config.deploymentId } : {}),
    nextVersion: context.nextVersion,
    hypdrivVersion: input.hypdrivVersion,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    basePath,
    trailingSlash,
    cacheComponents: context.config.cacheComponents === true,
    routes: [...routes, ...statics.routes],
    ...(context.outputs.middleware?.config.matchers
      ? {
          proxy: {
            matchers: context.outputs.middleware.config.matchers.map((m) => ({
              source: m.source,
              sourceRegex: m.sourceRegex,
              ...(m.has ? { has: m.has } : {}),
              ...(m.missing ? { missing: m.missing } : {}),
            })),
          },
        }
      : {}),
    staticFiles: { count: statics.count, immutablePrefixes: statics.immutablePrefixes },
    earlyHints,
    csp,
    speculation: { graph, excluded: config.performance.speculation?.exclude ?? [] },
    ...(purser ? { purser } : {}),
    weights: { client: clientWeights },
    budgets,
    warnings,
  };

  // Attach inferred cache policy ids so runtimes/CLI can show them without recomputing.
  if (config.cache.edge) {
    for (const route of manifest.routes) {
      const explicit = config.cache.edge.policies.find((p) => matchesAny(p.match, route.pathname));
      if (explicit) route.cachePolicyId = explicit.id;
      else if (config.cache.edge.infer && (route.classification === 'static' || route.classification === 'isr')) route.cachePolicyId = `inferred:${route.id}`;
      else if (config.cache.edge.infer && route.classification === 'shell' && config.cache.edge.inferredShell) route.cachePolicyId = `inferred:${route.id}`;
    }
  }

  return { manifest, failures, html };
}

async function hashesFor(doc: string): Promise<{ scriptHashes: string[]; styleHashes: string[] }> {
  const scripts = extractInlineScripts(doc);
  const styles = extractInlineStyles(doc);
  const scriptHashes = [...new Set(await Promise.all(scripts.map((s) => cspHash(s))))];
  const styleHashes = [...new Set(await Promise.all(styles.map((s) => cspHash(s))))];
  return { scriptHashes, styleHashes };
}

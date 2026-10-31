import { relative } from 'node:path';
import {
  type BudgetResult,
  cspHash,
  evaluateBudgets,
  type HypManifest,
  type HypRoute,
  type Logger,
  MANIFEST_VERSION,
  type ManifestFramework,
  matchesAny,
  type PurserManifest,
  type ResolvedConfig,
  sha256Hex,
  silentLogger,
} from '@hypdriv/core';
import {
  componentSpeculationRules,
  linkEntriesForRoute,
  linkHeaderValues,
  speculationScriptHash,
} from '@hypdriv/runtime';
import { mergeWithHtml, type RouteAssetSources } from './assets';
import type { AdapterFs } from './fs';
import { extractInlineScripts, extractInlineStyles, extractLinks } from './html';

export interface PurserVerifierInput {
  /** Prerendered HTML by route id (primary documents only). */
  html: Record<string, string>;
  /**
   * Every prerendered document by pathname (Next.js appends each route's RSC payload text, where atoms that only
   * appear in client-side navigations are referenced).
   */
  documents: Record<string, string>;
  config: ResolvedConfig;
  projectDir: string;
  /** The framework's build output directory (for collecting prerendered documents when none were passed). */
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

export type PurserVerifier = (input: PurserVerifierInput) => Promise<PurserVerifierResult>;

export type SecretsScanner = (input: { dirs: string[]; config: ResolvedConfig; log: Logger }) => Promise<{
  findings: Array<{ id: string; file: string; line: number; severity: 'error' | 'warn'; snippet: string }>;
  ok: boolean;
}>;

/** One route of the build, as the framework integration discovered it. */
export interface ManifestRouteInput {
  /** The route with its kind, classification and pattern; `assets` are filled in from `sources` and the HTML. */
  route: HypRoute;
  /** Client assets known from the framework's build manifest (merged with what the HTML references). */
  sources?: RouteAssetSources;
  /** The route's primary prerendered document (static, isr, shell), if any. */
  document?: string | null;
  /** More prerendered documents of a dynamic route (`/blog/a`, `/blog/b`), for links and per-path hashes. */
  concrete?: Array<{ pathname: string; html: string }>;
}

/** Framework-neutral input of `assembleManifest`. */
export interface AssembleManifestInput {
  config: ResolvedConfig;
  framework: ManifestFramework;
  buildId: string;
  deploymentId?: string;
  basePath?: string;
  trailingSlash?: boolean;
  cacheComponents?: boolean;
  routes: ManifestRouteInput[];
  /** Static-file routes and counts (public files the platform serves as is). */
  staticFiles: { count: number; immutablePrefixes: string[]; routes?: HypRoute[] };
  proxy?: HypManifest['proxy'];
  projectDir: string;
  /** The framework's build output directory. */
  distDir: string;
  /** Directories with client assets (secrets scan). */
  clientDirs: string[];
  /** Resolves a public asset path to its local file (sizes, Purser stylesheet detection); null when not local. */
  assetFile(publicPath: string): string | null;
  fs: AdapterFs;
  /** Every prerendered document by pathname, for Purser verification (default: the route documents). */
  documents?: Record<string, string>;
  purser?: PurserVerifier;
  secrets?: SecretsScanner;
  hypdrivVersion: string;
  log?: Logger;
  now?: () => Date;
  /** Framework-specific warnings found while discovering routes. */
  warnings?: string[];
  /** A token that marks the framework's own revalidation requests (only its SHA-256 is stored). */
  revalidationToken?: string | null;
  /** Pathnames that are never navigated to directly (framework error boundaries); excluded from budgets. */
  internalPages?: Iterable<string>;
}

export interface BuildManifestResult {
  manifest: HypManifest;
  /** Build must fail (budgets with failOn error, Purser verify errors, secrets). */
  failures: string[];
  /** Prerendered HTML by route id (static/isr/shell), useful to callers. */
  html: Record<string, string>;
}

const PAGE_KINDS = new Set<HypRoute['kind']>(['app-page', 'page']);

/** CSP hashes of a document's inline scripts and styles. */
export async function hashesFor(doc: string): Promise<{ scriptHashes: string[]; styleHashes: string[] }> {
  const scripts = extractInlineScripts(doc);
  const styles = extractInlineStyles(doc);
  const scriptHashes = [...new Set(await Promise.all(scripts.map((s) => cspHash(s))))];
  const styleHashes = [...new Set(await Promise.all(styles.map((s) => cspHash(s))))];
  return { scriptHashes, styleHashes };
}

/**
 * Content fingerprint of the build output (see `HypManifest.fingerprint`): the build id and deployment id,
 * every route's client assets (content-hashed names), CSP hashes of prerendered HTML, HypDriv's inline-script
 * hashes and the Purser stylesheet. Canonical JSON, SHA-256, 16 hex characters.
 */
export async function buildFingerprint(
  manifest: Pick<
    HypManifest,
    'buildId' | 'deploymentId' | 'routes' | 'csp' | 'inlineScriptHashes' | 'purser'
  >,
): Promise<string> {
  const routes = [...manifest.routes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => [r.id, r.classification, [...r.assets.js].sort(), [...r.assets.css].sort()]);
  const csp = Object.keys(manifest.csp)
    .sort()
    .map((id) => [
      id,
      [...(manifest.csp[id]?.scriptHashes ?? [])].sort(),
      [...(manifest.csp[id]?.styleHashes ?? [])].sort(),
    ]);
  const canonical = JSON.stringify({
    b: manifest.buildId,
    d: manifest.deploymentId ?? null,
    r: routes,
    c: csp,
    s: [...(manifest.inlineScriptHashes ?? [])].sort(),
    p: manifest.purser?.asset ?? null,
  });
  return (await sha256Hex(canonical)).slice(0, 16);
}

/**
 * Builds the HypDriv manifest from routes a framework integration discovered: client assets per route, CSP
 * hashes of static documents, Early Hints, the speculation graph, Purser verification, the secrets scan,
 * client weights and budgets, HypDriv's inline-script hashes, the content fingerprint and cache policy ids.
 * Shared by the Next.js adapter and the Vite integrations.
 */
export async function assembleManifest(input: AssembleManifestInput): Promise<BuildManifestResult> {
  const { config, fs } = input;
  const log = input.log ?? silentLogger;
  const basePath = input.basePath ?? '';
  const warnings: string[] = [...(input.warnings ?? [])];
  const failures: string[] = [];
  const html: Record<string, string> = {};
  const earlyHints: HypManifest['earlyHints'] = {};
  const csp: HypManifest['csp'] = {};
  const graph: Record<string, string[]> = {};
  const clientWeights: Record<string, { js: number; css: number }> = {};
  const sizeCache = new Map<string, number>();
  const sizeOf = (publicPath: string): number => {
    const file = input.assetFile(publicPath);
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
  for (const item of input.routes) {
    const { route } = item;
    const doc = PAGE_KINDS.has(route.kind) ? (item.document ?? null) : null;
    const merged = mergeWithHtml(
      item.sources ?? { js: route.assets.js, css: route.assets.css, fonts: route.assets.fonts, main: [] },
      doc,
    );
    route.assets = { js: merged.js, css: merged.css, fonts: merged.fonts };

    if (doc) {
      html[route.id] = doc;
      const links = new Set(extractLinks(doc, { basePath }));
      for (const c of item.concrete ?? []) {
        for (const l of extractLinks(c.html, { basePath })) links.add(l);
        // Hash every concrete static page too; stored under the concrete pathname.
        if (route.classification === 'static') csp[`${route.id}#${c.pathname}`] = await hashesFor(c.html);
      }
      graph[route.pathname] = [...links].filter((l) => l !== route.pathname);
      if (route.classification === 'static') csp[route.id] = await hashesFor(doc);
    }

    if (config.performance.earlyHints) {
      const entries = linkEntriesForRoute(route, config.performance.earlyHints, { main: merged.main });
      if (entries.length) earlyHints[route.id] = linkHeaderValues(entries);
    }

    if (PAGE_KINDS.has(route.kind)) {
      clientWeights[route.id] = {
        js: route.assets.js.reduce((n, f) => n + sizeOf(f), 0),
        css: route.assets.css.reduce((n, f) => n + sizeOf(f), 0),
      };
    }
    routes.push(route);
  }

  // Purser verification.
  let purser: PurserManifest | undefined;
  if (config.purser && input.purser) {
    try {
      const cssAssets = [...new Set(routes.flatMap((r) => r.assets.css))].sort();
      const readAsset = (publicPath: string): string | null => {
        const file = input.assetFile(publicPath);
        if (!file || !fs.exists(file)) return null;
        try {
          return fs.readText(file);
        } catch {
          return null;
        }
      };
      const documents =
        input.documents ??
        Object.fromEntries(
          input.routes.flatMap((r) => [
            ...(r.document ? [[r.route.pathname, r.document] as const] : []),
            ...(r.concrete ?? []).map((c) => [c.pathname, c.html] as const),
          ]),
        );
      const result = await input.purser({
        html,
        documents,
        config,
        projectDir: input.projectDir,
        distDir: input.distDir,
        cssAssets,
        readAsset,
        log,
      });
      if (result.manifest) purser = result.manifest;
      warnings.push(...result.warnings);
      if (result.errors?.length) failures.push(...result.errors.map((e) => `Purser: ${e}`));
      if (!result.ok && !result.errors?.length)
        failures.push(
          'Purser verification failed: prerendered HTML references atoms missing from the stylesheet (see warnings).',
        );
      // The theme fallback script is inlined by the root layout; allow it on hash-mode (static) routes.
      if (purser?.themeScriptHash) {
        for (const entry of Object.values(csp))
          if (!entry.scriptHashes.includes(purser.themeScriptHash))
            entry.scriptHashes.push(purser.themeScriptHash);
      }
    } catch (err) {
      warnings.push(`Purser verification skipped: ${(err as Error).message}`);
    }
  }

  // Secrets scan over client assets.
  if (config.security.secretsScan && input.secrets) {
    try {
      const dirs = input.clientDirs.filter((d) => fs.exists(d));
      const result = await input.secrets({ dirs, config, log });
      for (const f of result.findings) {
        const line = `secret pattern ${f.id} in ${relative(input.projectDir, f.file)}:${f.line} (${f.snippet})`;
        if (f.severity === 'error') failures.push(line);
        else warnings.push(line);
      }
      if (!result.ok && config.security.secretsScan.failOnFinding)
        failures.push('Secrets scan found credential-like strings in client assets.');
    } catch (err) {
      warnings.push(`Secrets scan skipped: ${(err as Error).message}`);
    }
  }

  // Budgets (client side; worker budgets are evaluated by `hypdriv analyze`).
  const internal = new Set(input.internalPages ?? []);
  const budgetInput = routes
    .filter((r) => PAGE_KINDS.has(r.kind) && !internal.has(r.pathname))
    .map((r) => ({
      id: r.id,
      pathname: r.pathname,
      js: clientWeights[r.id]?.js ?? 0,
      css: clientWeights[r.id]?.css ?? 0,
    }));
  const allJs = new Set<string>();
  for (const r of routes) for (const f of r.assets.js) allJs.add(f);
  const totalJs = [...allJs].reduce((n, f) => n + sizeOf(f), 0);
  const budgets: BudgetResult[] = evaluateBudgets(config.budgets, { routes: budgetInput, totalJs });
  const overBudget = budgets.filter((b) => b.status === 'error');
  if (overBudget.length && config.budgets.failOn === 'error')
    failures.push(`${overBudget.length} budget(s) exceeded: ${overBudget.map((b) => b.id).join(', ')}`);

  // Route-independent inline scripts HypDriv components render without a nonce (allowed by hash everywhere).
  const inlineScriptHashes: string[] = [];
  const spec = config.performance.speculation;
  if (spec && spec.inject !== 'off') {
    const rules = componentSpeculationRules(spec, basePath);
    if (rules) inlineScriptHashes.push(await speculationScriptHash(rules));
  }
  if (purser?.themeScriptHash) inlineScriptHashes.push(purser.themeScriptHash);

  const staticRoutes = input.staticFiles.routes ?? [];
  const manifest: HypManifest = {
    version: MANIFEST_VERSION,
    buildId: input.buildId,
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    ...(input.framework.name === 'next' ? { nextVersion: input.framework.version } : {}),
    framework: input.framework,
    hypdrivVersion: input.hypdrivVersion,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    basePath,
    trailingSlash: input.trailingSlash ?? false,
    cacheComponents: input.cacheComponents === true,
    routes: [...routes, ...staticRoutes],
    ...(input.proxy ? { proxy: input.proxy } : {}),
    staticFiles: { count: input.staticFiles.count, immutablePrefixes: input.staticFiles.immutablePrefixes },
    earlyHints,
    csp,
    ...(inlineScriptHashes.length ? { inlineScriptHashes: [...new Set(inlineScriptHashes)] } : {}),
    speculation: { graph, excluded: config.performance.speculation?.exclude ?? [] },
    ...(purser ? { purser } : {}),
    weights: { client: clientWeights },
    budgets,
    warnings,
  };

  manifest.fingerprint = await buildFingerprint(manifest);
  if (input.revalidationToken)
    manifest.revalidation = { tokenHash: await sha256Hex(input.revalidationToken) };

  // Attach inferred cache policy ids so runtimes/CLI can show them without recomputing.
  if (config.cache.edge) {
    for (const route of manifest.routes) {
      const explicit = config.cache.edge.policies.find((p) => matchesAny(p.match, route.pathname));
      if (explicit) route.cachePolicyId = explicit.id;
      // Same exclusions as the runtime's inference (@hypdriv/cache): shared fallback documents and documents
      // the platform's static layer serves are never edge-cached by inference.
      else if (route.fallback || route.servedStatically) continue;
      else if (
        config.cache.edge.infer &&
        (route.classification === 'static' || route.classification === 'isr')
      )
        route.cachePolicyId = `inferred:${route.id}`;
      else if (config.cache.edge.infer && route.classification === 'shell' && config.cache.edge.inferredShell)
        route.cachePolicyId = `inferred:${route.id}`;
    }
  }

  return { manifest, failures, html };
}

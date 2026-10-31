import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  assembleManifest,
  createNodeFs,
  defaultPurserVerifier,
  defaultSecretsScanner,
  type ManifestRouteInput,
  renderReport,
  type StaticDocument,
} from '@hypdriv/build';
import {
  createRouteMatcher,
  emptyManifest,
  HYPDRIV_VERSION,
  type HypManifest,
  type HypRoute,
  type Logger,
  type ManifestFramework,
  type ResolvedConfig,
  silentLogger,
} from '@hypdriv/core';
import { writeManifest } from '@hypdriv/core/node';
import { type DiscoveredRoute, normalizePathname, toHypRoute } from './routes';
import { assetsForEntries, type ViteManifest } from './vite-manifest';

/** A prerendered HTML document of the build. */
export interface PrerenderedDocument {
  /** The URL path it is served under (`/`, `/about`, `/blog/hello`). */
  pathname: string;
  /** Absolute path of the HTML file. */
  file: string;
}

export interface FinalizeInput {
  /** Project root (where `.hypdriv/` is written). */
  root: string;
  config: ResolvedConfig;
  framework: ManifestFramework;
  /** Build id (default: a fresh UUID; integrations pass the framework's own when it has one). */
  buildId?: string;
  deploymentId?: string;
  /** Public base path of client assets (Vite `base`). Default `/`. */
  base?: string;
  basePath?: string;
  trailingSlash?: boolean;
  routes: DiscoveredRoute[];
  documents: PrerenderedDocument[];
  /** The directory the platform serves static files from (`dist/client`, `.vercel/output/static`). */
  clientDir: string;
  /** Vite's client build manifest, for per-route assets of routes that declare `sources` by entry key. */
  viteManifest?: ViteManifest | null;
  /** Manifest keys of entries every page loads (the app entry), added to each page's assets. */
  sharedEntries?: string[];
  /** Content-hashed asset prefixes (`/assets/`, `/_astro/`, `/_app/immutable/`). */
  immutablePrefixes: string[];
  /** Framework warnings found while discovering routes. */
  warnings?: string[];
  /** Pathnames never navigated to directly (error pages), excluded from budgets. */
  internalPages?: string[];
  /**
   * Routes served by another route's document (a single-page app's catch-all → `/`): route pattern → document
   * pathname. The route gets the document's CSP hashes and Early Hints.
   */
  documentAliases?: Record<string, string>;
  /**
   * Whether the platform's static layer answers prerendered documents (Workers Static Assets, the Vercel CDN,
   * `hypdriv serve`; default true). Their routes get `servedStatically` and no inferred edge-cache policy. Pass
   * false when the application renders those paths itself at request time.
   */
  documentsServedStatically?: boolean;
  log?: Logger;
  /** Write `.hypdriv/manifest.json`, `.hypdriv/manifest.js` and `.hypdriv/report.md` (default true). */
  write?: boolean;
}

export interface FinalizeResult {
  manifest: HypManifest;
  /** Problems that must fail the build (budgets, Purser, secrets). */
  failures: string[];
  /** Every prerendered document with the route it belongs to (input of the static header rules). */
  documents: StaticDocument[];
}

const MAX_HTML = 2 * 1024 * 1024;

function readHtml(file: string): string | null {
  try {
    if (statSync(file).size > MAX_HTML) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

/** Maps a public URL path to its file in the client directory (null outside it or when absent). */
export function assetFileFor(clientDir: string, base: string, publicPath: string): string | null {
  const b = base.endsWith('/') ? base : `${base}/`;
  const path = publicPath.split('?')[0]!.split('#')[0]!;
  if (!path.startsWith(b) && b !== '/') return null;
  const rel = decodeURIComponent(path.slice(b.length).replace(/^\/+/, ''));
  if (!rel || rel.split('/').includes('..')) return null;
  const file = join(clientDir, rel);
  if (!file.startsWith(clientDir + sep) && file !== clientDir) return null;
  return existsSync(file) ? file : null;
}

/**
 * Turns the routes and prerendered documents of a Vite build into the HypDriv manifest (routes, assets, CSP
 * hashes, Early Hints, speculation graph, Purser verification, secrets scan, budgets) and writes it to
 * `.hypdriv/`. Documents are assigned to the most specific route that matches their path; documents no route
 * matches become static page routes of their own.
 */
export async function finalizeManifest(input: FinalizeInput): Promise<FinalizeResult> {
  const log = input.log ?? silentLogger;
  const base = input.base ?? '/';
  const servedStatically = input.documentsServedStatically ?? true;
  const docsByPath = new Map<string, PrerenderedDocument>();
  for (const d of input.documents) docsByPath.set(normalizePathname(d.pathname), d);

  // Assign documents to routes.
  const preliminary = input.routes.map((r) => toHypRoute(r));
  const matcher = createRouteMatcher({ routes: preliminary, basePath: '', trailingSlash: false });
  const assigned = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const pathname of docsByPath.keys()) {
    const hit = matcher.match(pathname);
    if (hit && hit.route.kind === 'page') {
      const list = assigned.get(hit.route.id) ?? [];
      list.push(pathname);
      assigned.set(hit.route.id, list);
    } else if (!hit) orphans.push(pathname);
  }

  const routes: ManifestRouteInput[] = [];
  input.routes.forEach((discovered, index) => {
    const id = preliminary[index]!.id;
    const paths = (assigned.get(id) ?? []).sort();
    const route: HypRoute = toHypRoute(
      { ...discovered, ...(paths.length && !preliminary[index]!.dynamic ? { prerendered: true } : {}) },
      preliminary[index]!.dynamic ? paths : [],
    );
    const primaryPath = paths.includes(route.pathname) ? route.pathname : paths[0];
    // A fully prerendered route (static, every path a file) is the static layer's; a dynamic route with some
    // prerendered paths still renders the others at request time.
    if (servedStatically && route.kind === 'page' && route.classification === 'static' && paths.length)
      route.servedStatically = true;
    const primary = primaryPath ? docsByPath.get(primaryPath) : undefined;
    const document = primary ? readHtml(primary.file) : null;
    const concrete: Array<{ pathname: string; html: string }> = [];
    for (const p of paths.filter((p) => p !== primaryPath).slice(0, 25)) {
      const html = readHtml(docsByPath.get(p)!.file);
      if (html) concrete.push({ pathname: p, html });
    }
    let sources = discovered.sources;
    if (input.sharedEntries?.length && input.viteManifest && route.kind === 'page') {
      const shared = assetsForEntries(input.viteManifest, input.sharedEntries, base);
      sources = sources
        ? {
            js: [...new Set([...shared.js, ...sources.js])],
            css: [...new Set([...shared.css, ...sources.css])],
            fonts: [...new Set([...shared.fonts, ...sources.fonts])],
            main: [...new Set([...shared.main, ...sources.main])],
          }
        : shared;
    }
    routes.push({ route, ...(sources ? { sources } : {}), document, concrete });
  });
  for (const pathname of orphans.sort()) {
    const route = toHypRoute({ pathname, kind: 'page', prerendered: true });
    if (servedStatically) route.servedStatically = true;
    routes.push({ route, document: readHtml(docsByPath.get(pathname)!.file) });
  }

  const config = input.config;
  const purser = config.purser ? await defaultPurserVerifier() : null;
  const secrets = config.security.secretsScan ? await defaultSecretsScanner() : null;
  const result = await assembleManifest({
    config,
    framework: input.framework,
    buildId: input.buildId ?? randomUUID(),
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    basePath: input.basePath ?? '',
    trailingSlash: input.trailingSlash ?? false,
    routes,
    staticFiles: {
      count: countFiles(input.clientDir),
      immutablePrefixes: input.immutablePrefixes,
    },
    projectDir: input.root,
    distDir: input.clientDir,
    clientDirs: [input.clientDir],
    assetFile: (publicPath) => assetFileFor(input.clientDir, base, publicPath),
    fs: createNodeFs(),
    documents: Object.fromEntries(
      [...docsByPath.entries()].flatMap(([p, d]) => {
        const html = readHtml(d.file);
        return html ? [[p, html] as const] : [];
      }),
    ),
    ...(purser ? { purser } : {}),
    ...(secrets ? { secrets } : {}),
    hypdrivVersion: HYPDRIV_VERSION,
    log,
    warnings: input.warnings ?? [],
    internalPages: input.internalPages ?? ['/404', '/500', '/_error'],
  });

  for (const [pattern, docPath] of Object.entries(input.documentAliases ?? {})) {
    const alias = result.manifest.routes.find((r) => r.pathname === normalizePathname(pattern));
    const source = finalMatcherFor(result.manifest).match(normalizePathname(docPath))?.route;
    if (!alias || !source) continue;
    if (result.manifest.csp[source.id]) result.manifest.csp[alias.id] = result.manifest.csp[source.id]!;
    if (result.manifest.earlyHints[source.id])
      result.manifest.earlyHints[alias.id] = result.manifest.earlyHints[source.id]!;
    alias.assets = source.assets;
    // The shell document the alias answers with is the static layer's file as well.
    if (source.servedStatically) alias.servedStatically = true;
  }

  // Prerendered documents with their route ids, for static headers.
  const finalMatcher = createRouteMatcher(result.manifest);
  const documents: StaticDocument[] = [];
  for (const pathname of docsByPath.keys()) {
    const hit = finalMatcher.match(pathname);
    if (hit) documents.push({ routeId: hit.route.id, pathname });
  }

  if (input.write !== false) {
    const { json } = await writeManifest(input.root, result.manifest);
    createNodeFs().writeText(join(input.root, '.hypdriv', 'report.md'), renderReport(result.manifest));
    for (const w of result.manifest.warnings) log.warn(`hypdriv: ${w}`);
    log.info(
      `hypdriv: manifest written (${result.manifest.routes.length} routes, ${documents.length} prerendered) → ${relative(input.root, json)}`,
    );
  }
  return { manifest: result.manifest, failures: result.failures, documents };
}

function finalMatcherFor(manifest: HypManifest) {
  return createRouteMatcher(manifest);
}

/** The manifest the runtime uses before a build exists (development): routes known so far, no documents. */
export function developmentManifest(framework: ManifestFramework, routes: DiscoveredRoute[]): HypManifest {
  return emptyManifest({
    framework,
    routes: routes.map((r) => ({
      ...toHypRoute(r),
      classification: r.kind === 'endpoint' ? 'route' : 'dynamic',
    })),
  });
}

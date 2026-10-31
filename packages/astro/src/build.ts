import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { StaticHeaderRule } from '@hypdriv/build';
import type { HypManifest, Logger, ManifestFramework, ResolvedConfig } from '@hypdriv/core';
import { silentLogger } from '@hypdriv/core';
import {
  addVercelMiddleware,
  type DiscoveredRoute,
  finalizeManifest,
  htmlPathname,
  type LoadedHypConfig,
  normalizePathname,
  type PrerenderedDocument,
  patchRuntimeManifest,
  rulesFor,
  writeCloudflareStatic,
  writeVercelStatic,
} from '@hypdriv/vite';
import type { AstroTarget } from './vite';

/** A file the build generated for a route (`astro:build:done` → `assets`). */
export interface GeneratedFile {
  /** The route pattern (`/`, `/blog/[slug]`, `/api/feed.json`). */
  route: string;
  /** Absolute path in the client directory. */
  file: string;
}

/** The HTML file a prerendered page pathname (`astro:build:done` → `pages`: `''`, `about/`, `404/`) was written to. */
export function pageFile(clientDir: string, pathname: string): string | null {
  const clean = pathname.replace(/^\/+/, '');
  const bare = clean.replace(/\/+$/, '');
  const candidates = bare
    ? [`${bare}/index.html`, `${bare}.html`, ...(clean.endsWith('.html') ? [clean] : [])]
    : ['index.html'];
  for (const candidate of candidates) {
    const file = join(clientDir, ...candidate.split('/'));
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Prerendered documents (HTML) and other static route outputs (prerendered endpoints) of a build, from the files
 * generated per route and the prerendered page pathnames (adapters with their own prerenderer do not always report
 * every page of a dynamic route in `assets`).
 */
export function classifyGeneratedFiles(
  clientDir: string,
  files: GeneratedFile[],
  pages: string[] = [],
): { documents: PrerenderedDocument[]; staticPaths: string[] } {
  const documents: PrerenderedDocument[] = [];
  const staticPaths: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    const rel = relative(clientDir, file);
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return;
    const posix = rel.split(sep).join('/');
    if (seen.has(posix)) return;
    seen.add(posix);
    if (posix.endsWith('.html')) documents.push({ pathname: htmlPathname(posix), file });
    else staticPaths.push(normalizePathname(posix));
  };
  for (const { file } of files) add(file);
  for (const pathname of pages) {
    const file = pageFile(clientDir, pathname);
    if (file) add(file);
  }
  documents.sort((a, b) => a.pathname.localeCompare(b.pathname));
  staticPaths.sort();
  return { documents, staticPaths };
}

/** Header names per path in an existing Cloudflare `_headers` file, outside HypDriv's generated block. */
export function existingCloudflareHeaders(content: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  let inBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('# hypdriv:start')) {
      inBlock = true;
      continue;
    }
    if (line.startsWith('# hypdriv:end')) {
      inBlock = false;
      current = null;
      continue;
    }
    if (inBlock || !line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const path = line.trim();
      current = out.get(path) ?? new Set<string>();
      out.set(path, current);
      continue;
    }
    if (!current) continue;
    const body = line.trim();
    const name = body.startsWith('!') ? body.slice(1).trim() : body.split(':')[0]!.trim();
    if (name) current.add(name.toLowerCase());
  }
  return out;
}

/**
 * Drops headers from HypDriv's rules that a rule for the same path in the existing `_headers` already sets
 * (`@astrojs/cloudflare` writes `/_astro/*  Cache-Control: …`): Cloudflare joins duplicate headers of matching
 * rules with a comma.
 */
export function withoutDuplicateHeaders(
  rules: StaticHeaderRule[],
  existing: Map<string, Set<string>>,
): StaticHeaderRule[] {
  const out: StaticHeaderRule[] = [];
  for (const rule of rules) {
    const taken = existing.get(rule.path);
    if (!taken) {
      out.push(rule);
      continue;
    }
    const set = Object.fromEntries(Object.entries(rule.set).filter(([k]) => !taken.has(k.toLowerCase())));
    const unset = rule.unset?.filter((k) => !taken.has(k.toLowerCase()));
    if (!Object.keys(set).length && !unset?.length) continue;
    out.push({ path: rule.path, set, ...(unset?.length ? { unset } : {}) });
  }
  return out;
}

/** An entry of `@astrojs/node`'s `dist/_headers.json` (read by its standalone server when `staticHeaders: true`). */
export interface NodeHeadersEntry {
  pathname: string;
  headers: Array<{ key: string; value: string }>;
}

function prefixMatches(rulePath: string, pathname: string): boolean {
  if (rulePath === '/*') return true;
  if (!rulePath.endsWith('/*')) return false;
  const prefix = rulePath.slice(0, -1);
  return pathname.startsWith(prefix);
}

/**
 * Renders the static rules as `@astrojs/node`'s `_headers.json` (base-less paths, which is how its standalone server
 * looks them up for prerendered routes). The server picks the first entry whose `pathname` contains the request
 * path, so every prerendered path gets an exact entry (both trailing-slash spellings) and entries are ordered
 * shortest first: the exact entry is then always the first match. Entries Astro wrote (its own CSP when
 * `security.csp` is on) are kept and win over HypDriv's for the same header.
 */
export function nodeHeadersEntries(input: {
  rules: StaticHeaderRule[];
  /** Base-less pathnames of every prerendered route output (documents and endpoints). */
  paths: string[];
  existing?: NodeHeadersEntry[];
}): NodeHeadersEntry[] {
  const exact = new Map(input.rules.filter((r) => !r.path.endsWith('/*')).map((r) => [r.path, r]));
  const prefixes = input.rules.filter((r) => r.path.endsWith('/*'));
  const existing = new Map((input.existing ?? []).map((e) => [e.pathname, e]));
  const paths = new Set<string>();
  for (const p of input.paths) {
    const normalized = normalizePathname(p);
    paths.add(normalized);
    if (normalized !== '/' && !/\.[A-Za-z0-9]+$/.test(normalized)) paths.add(`${normalized}/`);
  }
  for (const path of exact.keys()) paths.add(path);
  for (const path of existing.keys()) paths.add(path);
  const entries: NodeHeadersEntry[] = [];
  for (const pathname of paths) {
    const headers = new Map<string, string>();
    for (const rule of prefixes) {
      if (!prefixMatches(rule.path, pathname)) continue;
      for (const [k, v] of Object.entries(rule.set)) headers.set(k.toLowerCase(), v);
    }
    const own = exact.get(pathname);
    if (own) {
      for (const k of own.unset ?? []) headers.delete(k.toLowerCase());
      for (const [k, v] of Object.entries(own.set)) headers.set(k.toLowerCase(), v);
    }
    const names = new Map([...headers.keys()].map((k) => [k, k]));
    // Astro writes one spelling per page; its policy applies to the other trailing-slash spelling too.
    const alternate = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : `${pathname}/`;
    const astro = existing.get(pathname) ?? existing.get(alternate);
    const out: Array<{ key: string; value: string }> = [];
    for (const header of astro?.headers ?? []) {
      names.delete(header.key.toLowerCase());
      out.push({ key: header.key, value: header.value });
    }
    for (const [name] of names) out.push({ key: name, value: headers.get(name)! });
    if (out.length) entries.push({ pathname, headers: out });
  }
  entries.sort((a, b) => a.pathname.length - b.pathname.length || a.pathname.localeCompare(b.pathname));
  return entries;
}

interface VercelRouteLike {
  src?: string;
  dest?: string;
  status?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Gives `@astrojs/vercel`'s catch-all error route (`{ src: '^/.*$', dest: '/404.html', status: 404 }`) the static
 * headers of the error document it serves (its hash CSP): HypDriv's per-document rules match request paths, and
 * an unknown path is not the document's. Returns the number of routes changed.
 */
export function addErrorRouteHeaders(
  routes: VercelRouteLike[],
  rules: StaticHeaderRule[],
  basePath = '',
): number {
  let changed = 0;
  for (const route of routes) {
    if (route.status !== 404 || typeof route.dest !== 'string' || !route.dest.endsWith('.html')) continue;
    const dest = route.dest.startsWith(basePath) ? route.dest.slice(basePath.length) : route.dest;
    const pathname = `${basePath}${htmlPathname(dest.replace(/^\/+/, ''))}`;
    const rule = rules.find((r) => r.path === pathname);
    if (!rule || !Object.keys(rule.set).length) continue;
    route.headers = { ...(route.headers ?? {}), ...rule.set };
    changed++;
  }
  return changed;
}

/** Prefixes document rules with Astro's `base` (static configuration matches full request paths). */
export function withBasePath(rules: StaticHeaderRule[], basePath: string): StaticHeaderRule[] {
  if (!basePath) return rules;
  return rules.map((rule) =>
    rule.path === '/*' || rule.path.startsWith(`${basePath}/`) || rule.path === basePath
      ? rule
      : { ...rule, path: rule.path === '/' ? basePath : `${basePath}${rule.path}` },
  );
}

export interface FinalizeAstroInput {
  root: string;
  config: ResolvedConfig;
  framework: ManifestFramework;
  routes: DiscoveredRoute[];
  /** `astro:build:done` → `assets`: the files generated per route. */
  files: GeneratedFile[];
  /** `astro:build:done` → `pages`: the prerendered page pathnames (`''`, `about/`). */
  pages?: string[];
  /** Astro's client output directory (`dist/client` with an adapter). */
  clientDir: string;
  /** Astro's server output directory (`dist/server`). */
  serverDir: string;
  /** Astro's `outDir` (`dist`). */
  outDir: string;
  /** Astro's `base` (`/`, `/docs/`). */
  base: string;
  /** Astro's `build.assets` (`_astro`). */
  assetsDir: string;
  trailingSlash: 'always' | 'never' | 'ignore';
  targets: AstroTarget[];
  /** `@astrojs/node` serves `dist/_headers.json` (its `staticHeaders` option is on). */
  nodeStaticHeaders?: boolean;
  /**
   * The loaded HypDriv config, for HypDriv's Routing Middleware on Vercel: prerendered pages, which the CDN serves
   * without Astro's function, get the request stages too. Omit (or set `vercelMiddleware: false`) to skip it.
   */
  loaded?: LoadedHypConfig;
  vercelMiddleware?: boolean;
  log?: Logger;
}

export interface FinalizeAstroResult {
  manifest: HypManifest;
  rules: StaticHeaderRule[];
  /** Server files that now embed the final manifest. */
  patched: string[];
  /** Platform files written. */
  written: string[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Finalises an Astro build after every adapter hook ran: the HypDriv manifest from the routes and prerendered
 * documents, the static header rules in the target platform's configuration (Cloudflare `_headers`, Vercel Build
 * Output routes, `@astrojs/node`'s `_headers.json`), and the final manifest patched into every server output.
 * Throws when the manifest reports build failures (budgets, Purser, secrets).
 */
export async function finalizeAstroBuild(input: FinalizeAstroInput): Promise<FinalizeAstroResult> {
  const log = input.log ?? silentLogger;
  const base = input.base.endsWith('/') ? input.base : `${input.base}/`;
  const basePath = base === '/' ? '' : base.slice(0, -1);
  const assets = input.assetsDir.replace(/^\/+|\/+$/g, '') || '_astro';
  const immutablePrefixes = [`${base}${assets}/`];
  const { documents, staticPaths } = classifyGeneratedFiles(input.clientDir, input.files, input.pages);
  const result = await finalizeManifest({
    root: input.root,
    config: input.config,
    framework: input.framework,
    base,
    basePath,
    trailingSlash: input.trailingSlash === 'always',
    routes: input.routes,
    documents,
    clientDir: input.clientDir,
    immutablePrefixes,
    internalPages: ['/404', '/500'],
    log,
  });
  if (result.failures.length)
    throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
  const baseLess = rulesFor({
    config: input.config,
    manifest: result.manifest,
    documents: result.documents,
    immutablePrefixes,
  });
  const rules = withBasePath(baseLess, basePath);
  const written: string[] = [];
  const serverDirs = [input.serverDir];

  if (input.targets.includes('cloudflare')) {
    const headersFile = join(input.clientDir, '_headers');
    const existing = existsSync(headersFile) ? readFileSync(headersFile, 'utf8') : '';
    const { file } = writeCloudflareStatic({
      assetsDir: input.clientDir,
      rules: withoutDuplicateHeaders(rules, existingCloudflareHeaders(existing)),
      log,
    });
    written.push(file);
  }
  if (input.targets.includes('vercel')) {
    const outputDir = join(input.root, '.vercel', 'output');
    if (existsSync(join(outputDir, 'config.json'))) {
      const { file, functions } = writeVercelStatic({
        outputDir,
        rules,
        manifestJson: JSON.stringify(result.manifest),
        log,
      });
      const config = readJson<{ routes?: VercelRouteLike[] }>(file);
      if (config?.routes && addErrorRouteHeaders(config.routes, rules, basePath))
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      written.push(file);
      log.info(`hypdriv: Vercel header routes written, manifest copied into ${functions} function(s)`);
      if (input.loaded)
        await addVercelMiddleware({
          root: input.root,
          outputDir,
          config: input.loaded,
          manifest: result.manifest,
          paths:
            input.vercelMiddleware === false
              ? []
              : documents.map((d) => (d.pathname === '/' ? basePath || '/' : `${basePath}${d.pathname}`)),
          log,
        });
    } else log.warn('hypdriv: .vercel/output/config.json not found; Vercel header routes were not written');
    serverDirs.push(join(outputDir, 'functions'), join(outputDir, '_functions'));
  }
  if (input.targets.includes('node')) {
    const file = join(input.outDir, '_headers.json');
    const existing = readJson<NodeHeadersEntry[]>(file) ?? [];
    const entries = nodeHeadersEntries({
      rules: baseLess,
      paths: [...documents.map((d) => d.pathname), ...staticPaths],
      existing: Array.isArray(existing) ? existing : [],
    });
    writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
    written.push(file);
    if (!input.nodeStaticHeaders && documents.length)
      log.warn(
        "hypdriv: @astrojs/node serves prerendered pages without HypDriv's static headers unless its `staticHeaders` option is on: node({ mode: 'standalone', staticHeaders: true })",
      );
  }

  const patched = patchRuntimeManifest(serverDirs, result.manifest);
  if (patched.length) log.info(`hypdriv: final manifest patched into ${patched.length} server file(s)`);
  else log.warn('hypdriv: no server output embeds the HypDriv manifest (is the integration installed?)');
  return { manifest: result.manifest, rules, patched, written };
}

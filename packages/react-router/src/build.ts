import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { StaticDocument } from '@hypdriv/build';
import {
  type HypManifest,
  type Logger,
  type ManifestFramework,
  routePatternToRegex,
  silentLogger,
} from '@hypdriv/core';
import { installedVersion } from '@hypdriv/core/node';
import {
  type DiscoveredRoute,
  finalizeManifest,
  type LoadedHypConfig,
  normalizePathname,
  type PrerenderedDocument,
  patchRuntimeManifest,
  rulesFor,
  writeCloudflareStatic,
} from '@hypdriv/vite';
import { basenamePrefix, discoverRoutes, readBrowserManifest } from './routes';
import type { ReactRouterTarget, ResolvedReactRouterConfigLike } from './state';
import { type BuildManifestLike, writeReactRouterVercelOutput } from './vercel';

/** The parts of Vite's resolved config the build step reads. */
export interface ViteConfigLike {
  root: string;
  base?: string;
  build?: { assetsDir?: string; outDir?: string };
  environments?: Record<string, { build?: { outDir?: string; assetsDir?: string } } | undefined>;
}

export interface ReactRouterBuildInput {
  root: string;
  reactRouterConfig: ResolvedReactRouterConfigLike;
  buildManifest?: BuildManifestLike | undefined;
  viteConfig: ViteConfigLike;
  config: LoadedHypConfig;
  target: ReactRouterTarget;
  /** The build's prerender token, erased from the server output. */
  token?: string | null;
  /** The runtime manifest module was bundled into a server environment (its absence from the output is fatal). */
  manifestBundled?: boolean;
  /** Vercel: build HypDriv's Routing Middleware for statically served paths (default true). */
  vercelMiddleware?: boolean;
  /** Extra directories whose built server code embeds the runtime manifest. */
  serverDirs?: string[];
  log?: Logger;
}

export interface ReactRouterBuildResult {
  manifest: HypManifest;
  target: ReactRouterTarget;
  clientDir: string;
  serverDir: string;
  /** Prerendered documents with their routes. */
  documents: StaticDocument[];
  /** Server files the final manifest was written into. */
  patched: string[];
  /** Server files the prerender token was erased from. */
  tokenErased: string[];
  /** Files written for the platform (`_headers`, `.vercel/output/config.json`). */
  outputs: string[];
}

/** A file of the client build that is a prerendered document. */
interface HtmlFile {
  /** Public path of the file (`/about/index.html`). */
  file: string;
  /** The URL path it answers (`/about`). */
  pathname: string;
  abs: string;
}

/** `index.html` → `/`, `about/index.html` → `/about`, `404.html` → `/404`. */
export function documentPathname(publicFile: string): string {
  const clean = publicFile.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean === 'index.html') return '/';
  if (clean.endsWith('/index.html')) return normalizePathname(`/${clean.slice(0, -'/index.html'.length)}`);
  return normalizePathname(`/${clean.replace(/\.html$/, '')}`);
}

/** Every file of the client build outside the content-hashed assets directory and dot-directories. */
export function clientFiles(clientDir: string, assetsDir: string): string[] {
  const out: string[] = [];
  const skip = assetsDir.replace(/^\/+|\/+$/g, '');
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      const rel = relative(clientDir, full).split(sep).join('/');
      if (e.isDirectory()) {
        if (rel === skip) continue;
        walk(full);
      } else out.push(`/${rel}`);
    }
  };
  walk(clientDir);
  return out.sort();
}

/** Replaces every occurrence of the prerender token in the built server code (and its source maps) with ''. */
export function eraseToken(dirs: string[], token: string | null | undefined): string[] {
  if (!token) return [];
  const touched: string[] = [];
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.(?:m?js|cjs|map)$/.test(e.name)) continue;
      try {
        if (statSync(full).size > 64 * 1024 * 1024) continue;
        const code = readFileSync(full, 'utf8');
        if (!code.includes(token)) continue;
        writeFileSync(full, code.split(token).join(''));
        touched.push(full);
      } catch {
        // unreadable file: skip
      }
    }
  };
  for (const dir of new Set(dirs)) walk(dir);
  return touched;
}

function resolveDir(root: string, dir: string | undefined, fallback: string): string {
  return resolve(root, dir ?? fallback);
}

/**
 * Finishes a React Router build for HypDriv once React Router is done (prerendering included): discovers the routes
 * and prerendered documents, writes `.hypdriv/manifest.json`, patches the final manifest into the server output and
 * erases the prerender token from it, then writes the platform's static configuration — Cloudflare `_headers` or
 * the Vercel Build Output. Throws when the manifest reports failures (budgets, Purser, secrets).
 */
export async function finalizeReactRouterBuild(
  input: ReactRouterBuildInput,
): Promise<ReactRouterBuildResult> {
  const log = input.log ?? silentLogger;
  const { root, reactRouterConfig: rr, viteConfig } = input;
  const clientEnv = viteConfig.environments?.client?.build;
  const clientDir = resolveDir(root, clientEnv?.outDir, join(rr.buildDirectory, 'client'));
  const serverDir = join(rr.buildDirectory, 'server');
  const assetsDir = clientEnv?.assetsDir ?? viteConfig.build?.assetsDir ?? 'assets';
  const base = viteConfig.base || '/';
  const ssr = rr.ssr !== false;
  const prefix = basenamePrefix(rr.basename);

  const browser = readBrowserManifest(clientDir, assetsDir);
  const discovery = discoverRoutes({
    routes: rr.routes,
    browser,
    basename: rr.basename,
    appDirectory: rr.appDirectory,
    root,
  });
  const routes: DiscoveredRoute[] = [...discovery.routes];

  // Prerendered documents and other statically served build output.
  const files = clientFiles(clientDir, assetsDir);
  const html: HtmlFile[] = files
    .filter((f) => f.endsWith('.html'))
    .map((file) => ({ file, pathname: documentPathname(file), abs: join(clientDir, file.slice(1)) }));
  const shellFile = ssr
    ? null
    : (html.find((h) => h.file === `${prefix}/__spa-fallback.html`) ??
      html.find((h) => h.file === `${prefix}/index.html`) ??
      null);
  const endpointMatchers = routes
    .filter((r) => r.kind === 'endpoint')
    .map((r) => new RegExp(routePatternToRegex(r.pathname)));
  const staticPaths = files.filter((f) => f.endsWith('.data') || endpointMatchers.some((m) => m.test(f)));

  const documentAliases: Record<string, string> = {};
  if (shellFile) {
    // A single-page app: every URL without its own document gets the shell (and its CSP).
    const catchAll = normalizePathname(`${prefix}/[...path]`);
    if (!routes.some((r) => r.pathname === catchAll))
      routes.push({ pathname: catchAll, kind: 'page', prerendered: true, fallback: true });
    const documented = new Set(html.map((h) => h.pathname));
    for (const route of routes) {
      if (route.kind !== 'page' || documented.has(route.pathname)) continue;
      documentAliases[route.pathname] = shellFile.pathname;
    }
  }

  const framework: ManifestFramework = {
    name: 'react-router',
    version: installedVersion(root, 'react-router') ?? 'unknown',
    bundler: 'vite',
    bundlerVersion: installedVersion(root, 'vite') ?? 'unknown',
    adapter: input.target,
  };
  const documents: PrerenderedDocument[] = html.map((h) => ({ pathname: h.pathname, file: h.abs }));
  const immutablePrefixes = [`${base.replace(/\/$/, '')}/${assetsDir.replace(/^\/+|\/+$/g, '')}/`];
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  const result = await finalizeManifest({
    root,
    config: input.config.resolved,
    framework,
    base,
    routes,
    documents,
    ...(Object.keys(documentAliases).length ? { documentAliases } : {}),
    clientDir,
    immutablePrefixes,
    warnings: discovery.warnings,
    ...(deploymentId ? { deploymentId } : {}),
    log,
  });
  if (result.failures.length)
    throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
  const { manifest } = result;

  // The server bundles were built before prerendering finished: write the final manifest into them and remove
  // the prerender token, so production code can never treat a request as a build request.
  const serverDirs = [...new Set([serverDir, ...(input.serverDirs ?? [])])].filter((d) => existsSync(d));
  const patched = patchRuntimeManifest(serverDirs, manifest);
  if (input.manifestBundled && !patched.length)
    throw new Error(
      `hypdriv: the runtime manifest was bundled into the server build but no file under ${serverDirs.map((d) => relative(root, d)).join(', ')} carries it; the deployment would run with a stale manifest`,
    );
  if (patched.length) log.info(`hypdriv: final manifest patched into ${patched.length} server file(s)`);
  const tokenErased = eraseToken(serverDirs, input.token);

  const shellDoc = shellFile ? result.documents.find((d) => d.pathname === shellFile.pathname) : undefined;
  const rules = rulesFor({
    config: input.config.resolved,
    manifest,
    documents: result.documents,
    immutablePrefixes,
    ...(shellDoc ? { spaShell: shellDoc } : {}),
  });
  const outputs: string[] = [];
  if (input.target === 'cloudflare') {
    const { file } = writeCloudflareStatic({ assetsDir: clientDir, rules, log });
    outputs.push(file);
  } else if (input.target === 'vercel') {
    const assigned = new Map(result.documents.map((d) => [d.pathname, d.routeId]));
    const vercel = await writeReactRouterVercelOutput({
      root,
      clientDir,
      serverDir,
      serverBuildFile: rr.serverBuildFile ?? 'index.js',
      buildManifest: input.buildManifest,
      routes: rr.routes,
      basename: rr.basename,
      ssr,
      spaShell: shellFile?.file ?? null,
      documents: html
        .filter((h) => assigned.has(h.pathname))
        .map(({ file, pathname }) => ({ file, pathname })),
      staticPaths,
      rules,
      manifest,
      config: input.config,
      middleware: input.vercelMiddleware !== false,
      frameworkVersion: framework.version,
      log,
    });
    outputs.push(join(vercel.dir, 'config.json'));
  }
  return {
    manifest,
    target: input.target,
    clientDir,
    serverDir,
    documents: result.documents,
    patched,
    tokenErased,
    outputs,
  };
}

/** Dev-time routes (no build output yet): kinds from the module sources. */
export function developmentRoutes(rr: ResolvedReactRouterConfigLike, root: string): DiscoveredRoute[] {
  return discoverRoutes({ routes: rr.routes, basename: rr.basename, appDirectory: rr.appDirectory, root })
    .routes;
}

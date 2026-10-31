import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createNodeFs, renderReport, type StaticHeaderRule } from '@hypdriv/build';
import type { HypManifest, Logger, ManifestFramework, ResolvedConfig } from '@hypdriv/core';
import { writeManifest } from '@hypdriv/core/node';
import {
  finalizeManifest,
  MANIFEST_SENTINEL_VALUE,
  normalizePathname,
  patchRuntimeManifest,
  rulesFor,
} from '@hypdriv/vite';
import { routeAssets } from './assets';
import { mergeMetaHashes, stageDocuments } from './documents';
import { routesFromBuilder, type SvelteKitRouteLike } from './routes';

/** The parts of SvelteKit's `Builder` the integration reads (kept structural so tests can pass fixtures). */
export interface BuilderLike {
  config: {
    appDir: string;
    outDir: string;
    paths: { base: string; assets: string };
    files?: { routes?: string };
    version?: { name?: string };
  };
  routes: readonly SvelteKitRouteLike[];
  prerendered: {
    pages: Map<string, { file: string }>;
    assets: Map<string, unknown>;
    paths: string[];
  };
  getClientDirectory(): string;
  getServerDirectory(): string;
  log: {
    info(message: string): void;
    minor(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface PreparedBuild {
  manifest: HypManifest;
  rules: StaticHeaderRule[];
  /** Server files the final manifest was patched into before the adapter ran. */
  patched: string[];
  immutablePrefixes: string[];
}

/** A HypDriv logger that prints through SvelteKit's builder log. */
export function builderLogger(log: BuilderLike['log']): Logger {
  const logger: Logger = {
    level: 'info',
    debug: () => undefined,
    info: (m) => log.minor(m),
    warn: (m) => log.warn(m),
    error: (m) => log.error(m),
    child: () => logger,
  };
  return logger;
}

/**
 * Builds the final manifest of a SvelteKit build (prerendering finished, the adapter not run yet): routes from
 * `builder.routes`, client assets from the server output, CSP hashes of the prerendered pages (plus the hashes of
 * SvelteKit's own `<meta>` policy), Early Hints, budgets. Writes `.hypdriv/`, patches the manifest into SvelteKit's
 * server output (every adapter copies or bundles it from there) and returns the static header rules. Throws when
 * the manifest reports build failures (budgets, Purser verification, secrets).
 */
export async function prepareBuild(input: {
  root: string;
  builder: BuilderLike;
  config: ResolvedConfig;
  framework: ManifestFramework;
}): Promise<PreparedBuild> {
  const { root, builder, config } = input;
  const log = builderLogger(builder.log);
  const base = builder.config.paths.base.replace(/\/+$/, '');
  const assetsBase = builder.config.paths.assets || base;
  const appDir = builder.config.appDir;
  const immutablePrefixes = [`${base}/${appDir}/immutable/`];
  const serverDir = builder.getServerDirectory();
  const clientDir = builder.getClientDirectory();
  const routesDir = builder.config.files?.routes ?? 'src/routes';

  const assets = routeAssets(serverDir, assetsBase || '/');
  const warnings: string[] = [];
  if (!assets.size && builder.routes.some((r) => r.page.methods.length))
    warnings.push(
      'SvelteKit server output has an unexpected shape: client assets per route (Early Hints) are unavailable',
    );
  const routes = routesFromBuilder({
    routes: builder.routes,
    root,
    routesDir,
    assets,
    prerenderedEndpoints: builder.prerendered.assets.keys(),
  });

  // Prerendered pages with root-relative asset URLs (SvelteKit writes relative ones by default).
  const outDir = resolve(root, builder.config.outDir);
  const prerenderedDir = join(outDir, 'output', 'prerendered', 'pages');
  const staging = join(outDir, 'hypdriv', 'prerendered');
  const documents = stageDocuments(builder.prerendered.pages, prerenderedDir, staging);

  const result = await finalizeManifest({
    root,
    config,
    framework: input.framework,
    ...(builder.config.version?.name ? { buildId: builder.config.version.name } : {}),
    base: `${base}/`,
    basePath: base,
    trailingSlash: false,
    routes,
    documents,
    clientDir,
    immutablePrefixes,
    warnings,
    log,
    write: false,
  });
  if (result.failures.length)
    throw new Error(`hypdriv: build failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`);
  const manifest = result.manifest;

  // SvelteKit's `<meta http-equiv="content-security-policy">` (its `csp` option) is enforced with HypDriv's header.
  const byPath = new Map(documents.map((d) => [normalizePathname(d.pathname), d]));
  const merged = mergeMetaHashes(
    manifest,
    result.documents.flatMap((d) => {
      const doc = byPath.get(normalizePathname(d.pathname));
      if (!doc) return [];
      try {
        return [{ routeId: d.routeId, pathname: d.pathname, html: readFileSync(doc.file, 'utf8') }];
      } catch {
        return [];
      }
    }),
  );
  if (merged) log.info(`hypdriv: SvelteKit's <meta> CSP hashes added for ${merged} prerendered page(s)`);

  const { json } = await writeManifest(root, manifest);
  createNodeFs().writeText(join(root, '.hypdriv', 'report.md'), renderReport(manifest));
  for (const w of manifest.warnings) log.warn(`hypdriv: ${w}`);
  builder.log.info(
    `hypdriv: manifest written (${manifest.routes.length} routes, ${result.documents.length} prerendered) → ${relative(root, json)}`,
  );

  const patched = patchRuntimeManifest([serverDir], manifest);
  // Every SvelteKit adapter caches `/_app/immutable/*` itself (adapter-cloudflare's `_headers`, adapter-vercel's
  // route, adapter-node's file table): a second rule would join values on Cloudflare (`…, immutable, no-cache`).
  const rules = rulesFor({ config, manifest, documents: result.documents, immutablePrefixes: [] });
  return { manifest, rules, patched, immutablePrefixes };
}

const CODE_FILE = /\.(?:m?js|cjs)$/;

/**
 * Built server files under `dirs` that embed HypDriv's runtime manifest, split by whether they carry `manifest`
 * (matched by its `generatedAt` stamp) or another one. Function bundles (`*.func`) are searched including their
 * traced `node_modules`; symbolic links are not followed (adapter-vercel links route functions to one bundle).
 */
export function embeddedManifests(
  dirs: string[],
  manifest: HypManifest,
): { current: string[]; stale: string[] } {
  const current: string[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, inFunction: boolean) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' && !inFunction) continue;
        walk(full, inFunction || e.name.endsWith('.func'));
        continue;
      }
      if (!e.isFile() || !CODE_FILE.test(e.name) || seen.has(full)) continue;
      seen.add(full);
      let code: string;
      try {
        code = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!code.includes(MANIFEST_SENTINEL_VALUE)) continue;
      (code.includes(manifest.generatedAt) ? current : stale).push(full);
    }
  };
  for (const dir of dirs) walk(dir, dir.endsWith('.func'));
  return { current, stale };
}

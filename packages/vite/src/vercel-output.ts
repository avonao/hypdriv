import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeVercelRoutes,
  type StaticDocument,
  type StaticHeaderRule,
  VERCEL_ROUTE_MARKER,
  type VercelRoute,
} from '@hypdriv/build';
import type { HypManifest, Logger } from '@hypdriv/core';
import { configModuleCode, type LoadedHypConfig, VIRTUAL_CONFIG } from './host';
import { PRIVATE_BUILD_FILES } from './targets';

/** Files of a Vite client build that only configure other platforms. */
const PLATFORM_FILES = new Set(['_headers', '_redirects', '_routes.json', '.assetsignore']);

/** The Node.js runtime of Hypdriv's Vercel functions (the build machine's major when Vercel supports it). */
export function vercelNodeRuntime(version: string = process.versions.node): string {
  const major = Number(version.split('.')[0]);
  // The newest Vercel runtime not newer than the building Node (odd releases map to the LTS line below them).
  const supported = VERCEL_NODE_MAJORS.filter((m) => m <= major);
  return `nodejs${supported.length ? Math.max(...supported) : VERCEL_NODE_MAJORS[0]}.x`;
}

/** Node.js majors Vercel Functions run (Build Output API `runtime: nodejs<major>.x`). */
export const VERCEL_NODE_MAJORS = [22, 24, 26] as const;

/**
 * The middleware runtime module, resolved from this package rather than the application: framework apps depend on
 * their integration (`@hypdriv/astro`, `@hypdriv/vinext`…), not necessarily on `@hypdriv/vite` itself.
 */
function vercelMiddlewareModule(): string {
  const specifier = '@hypdriv/vite/vercel-middleware';
  try {
    const resolved = import.meta.resolve?.(specifier);
    if (resolved?.startsWith('file:')) return fileURLToPath(resolved);
  } catch {
    // fall through
  }
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return specifier;
  }
}

/**
 * Bundles Hypdriv's Routing Middleware (config + final manifest + runtime) into one ESM file for a Build Output
 * API Node.js function.
 */
export async function buildVercelMiddleware(input: {
  root: string;
  funcDir: string;
  config: LoadedHypConfig;
  manifest: HypManifest;
}): Promise<void> {
  const { build } = await import('vite');
  rmSync(input.funcDir, { recursive: true, force: true });
  // A real entry file inside the project so `@hypdriv/vite` resolves from the application's dependencies.
  const entryDir = join(input.root, 'node_modules', '.hypdriv');
  mkdirSync(entryDir, { recursive: true });
  const entry = join(entryDir, 'vercel-middleware-entry.mjs');
  writeFileSync(
    entry,
    [
      `import config from ${JSON.stringify(VIRTUAL_CONFIG)};`,
      `import { createVercelMiddleware } from ${JSON.stringify(vercelMiddlewareModule())};`,
      `const manifest = JSON.parse(${JSON.stringify(JSON.stringify(input.manifest))});`,
      'export default createVercelMiddleware({ config, manifest });',
      '',
    ].join('\n'),
  );
  await build({
    configFile: false,
    root: input.root,
    logLevel: 'warn',
    plugins: [
      {
        name: 'hypdriv:vercel-middleware-config',
        enforce: 'pre',
        resolveId(id) {
          return id === VIRTUAL_CONFIG ? `\0${VIRTUAL_CONFIG}` : null;
        },
        load(id) {
          return id === `\0${VIRTUAL_CONFIG}` ? configModuleCode(input.config) : null;
        },
      },
    ],
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: entry,
      outDir: input.funcDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      target: 'node22',
      copyPublicDir: false,
      rolldownOptions: {
        output: { entryFileNames: 'index.mjs', format: 'es', codeSplitting: false },
      },
    } as never,
  });
  writeFileSync(join(input.funcDir, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  writeFileSync(
    join(input.funcDir, '.vc-config.json'),
    `${JSON.stringify(
      {
        runtime: vercelNodeRuntime(),
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        useWebApi: true,
        supportsResponseStreaming: true,
        shouldAddHelpers: false,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Writes the Vercel Build Output (`.vercel/output`) for a plain Vite build: the client files as static output,
 * Hypdriv's header routes, clean URLs for multi-page builds, the SPA fallback, and (by default) Hypdriv's Routing
 * Middleware so the request stages run before the CDN. Vercel deploys this output as is.
 */
export async function writeVercelOutput(input: {
  root: string;
  clientDir: string;
  rules: StaticHeaderRule[];
  manifest: HypManifest;
  config: LoadedHypConfig;
  spa: boolean;
  documents: StaticDocument[];
  middleware: boolean;
  log: Pick<Logger, 'info' | 'warn'>;
}): Promise<string> {
  const out = join(input.root, '.vercel', 'output');
  rmSync(out, { recursive: true, force: true });
  const staticDir = join(out, 'static');
  mkdirSync(staticDir, { recursive: true });
  cpSync(input.clientDir, staticDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(input.clientDir, src);
      if (!rel) return true;
      const first = rel.split(/[\\/]/)[0]!;
      return !PRIVATE_BUILD_FILES.includes(first) && !(rel === first && PLATFORM_FILES.has(first));
    },
  });

  const routes: VercelRoute[] = mergeVercelRoutes([], input.rules);
  routes.push({ handle: 'filesystem' });
  // The SPA shell answers unknown extensionless paths, never `/api/*` (Vercel Functions or a 404).
  if (input.spa && existsSync(join(staticDir, 'index.html')))
    routes.push({ src: '^/(?!api(?:/|$))(?!.*\\.[A-Za-z0-9]+$).*$', dest: '/index.html', check: true });
  routes.push({ handle: 'error' });
  if (existsSync(join(staticDir, '404.html'))) routes.push({ status: 404, src: '^.*$', dest: '/404.html' });

  // Multi-page builds: `about.html` is served at `/about`.
  const overrides: Record<string, { path: string }> = {};
  for (const doc of input.documents) {
    if (doc.pathname === '/') continue;
    const name = `${doc.pathname.slice(1)}.html`;
    if (existsSync(join(staticDir, name))) overrides[name] = { path: doc.pathname.slice(1) };
  }
  const framework = input.manifest.framework;
  writeFileSync(
    join(out, 'config.json'),
    `${JSON.stringify(
      {
        version: 3,
        routes,
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(framework ? { framework: { version: framework.version } } : {}),
      },
      null,
      2,
    )}\n`,
  );
  if (input.middleware)
    await addVercelMiddleware({
      root: input.root,
      outputDir: out,
      config: input.config,
      manifest: input.manifest,
    });
  input.log.info(`hypdriv: Vercel Build Output written → ${relative(input.root, out)}`);
  return out;
}

/** The middleware path of Hypdriv's Routing Middleware in a Build Output. */
export const VERCEL_MIDDLEWARE_PATH = '_hypdriv/middleware';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `src` regex (and raw sources) of Hypdriv's Routing Middleware: every path except content-hashed assets, or —
 * for frameworks whose own function runs the pipeline for on-demand routes — only the prerendered documents the
 * CDN serves without application code (`/about`, `/about/`, `/about.html`), so no request runs the stages twice.
 */
export function vercelMiddlewareSource(input: { immutablePrefixes: string[]; paths?: string[] }): {
  src: string;
  raw: string[];
} {
  if (input.paths) {
    const unique = [...new Set(input.paths.map((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p)))].sort();
    const alternatives = unique.map((p) =>
      p === '/' ? '/(?:index\\.html)?' : `${escapeRegex(p)}(?:/|\\.html)?`,
    );
    return { src: `^(?:${alternatives.join('|')})$`, raw: unique };
  }
  const immutable = input.immutablePrefixes.map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean);
  const exclude = immutable.length ? `(?!${immutable.map((p) => `${escapeRegex(p)}/`).join('|')})` : '';
  return { src: `^/${exclude}.*$`, raw: [`/${exclude ? `(${exclude}.*)` : '(.*)'}`] };
}

/**
 * Adds Hypdriv's Routing Middleware to a Build Output (`.vercel/output`): bundles it as a Node.js function and
 * inserts its route right after Hypdriv's header routes (before the framework's rewrites and `handle: filesystem`),
 * replacing one from a previous run. Plain Vite apps run it for every path except content-hashed assets; framework
 * integrations pass `paths` (their prerendered documents), so static pages get the request stages — rate limiting,
 * bot shield, maintenance, redirects, geo — while the framework's function keeps running them for everything else.
 * An empty `paths` list removes the middleware.
 */
export async function addVercelMiddleware(input: {
  root: string;
  outputDir: string;
  config: LoadedHypConfig;
  manifest: HypManifest;
  paths?: string[];
  /**
   * Request conditions the CDN-served pages answer under (Build Output `missing`): requests that carry one of these
   * headers go to the framework's function, which runs the pipeline itself — e.g. RSC payload requests (`rsc`).
   */
  missingHeaders?: string[];
  log?: Pick<Logger, 'info'>;
}): Promise<{ paths: number | 'all' } | null> {
  const file = join(input.outputDir, 'config.json');
  const config = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 3 }) as {
    routes?: VercelRoute[];
    [key: string]: unknown;
  };
  const routes = (config.routes ?? []).filter((r) => r.middlewarePath !== VERCEL_MIDDLEWARE_PATH);
  const funcDir = join(input.outputDir, 'functions', '_hypdriv', 'middleware.func');
  if (input.paths && !input.paths.length) {
    rmSync(funcDir, { recursive: true, force: true });
    config.routes = routes;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return null;
  }
  await buildVercelMiddleware({ root: input.root, funcDir, config: input.config, manifest: input.manifest });
  const { src, raw } = vercelMiddlewareSource({
    immutablePrefixes: input.manifest.staticFiles.immutablePrefixes,
    ...(input.paths ? { paths: input.paths } : {}),
  });
  const route: VercelRoute = {
    src,
    // Prerendered files only answer GET and HEAD; other methods reach the framework's function.
    ...(input.paths ? { methods: ['GET', 'HEAD'] } : {}),
    ...(input.missingHeaders?.length
      ? { missing: input.missingHeaders.map((key) => ({ type: 'header', key })) }
      : {}),
    middlewarePath: VERCEL_MIDDLEWARE_PATH,
    middlewareRawSrc: raw,
    continue: true,
    override: true,
  };
  let lastHeader = -1;
  routes.forEach((r, i) => {
    if (r.headers?.[VERCEL_ROUTE_MARKER] !== undefined) lastHeader = i;
  });
  const fs = routes.findIndex((r) => r.handle !== undefined);
  const at = lastHeader >= 0 ? lastHeader + 1 : fs >= 0 ? fs : routes.length;
  routes.splice(at, 0, route);
  config.routes = routes;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  input.log?.info(
    `hypdriv: Routing Middleware → ${input.paths ? `${raw.length} prerendered document(s)` : 'every path except hashed assets'}`,
  );
  return { paths: input.paths ? raw.length : 'all' };
}

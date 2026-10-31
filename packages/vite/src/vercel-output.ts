import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  mergeVercelRoutes,
  type StaticDocument,
  type StaticHeaderRule,
  type VercelRoute,
} from '@hypdriv/build';
import type { HypManifest, Logger } from '@hypdriv/core';
import { configModuleCode, type LoadedHypConfig, VIRTUAL_CONFIG } from './host';
import { PRIVATE_BUILD_FILES } from './targets';

/** Files of a Vite client build that only configure other platforms. */
const PLATFORM_FILES = new Set(['_headers', '_redirects', '_routes.json', '.assetsignore']);

/** The Node.js runtime of HypDriv's Vercel functions (the build machine's major when Vercel supports it). */
export function vercelNodeRuntime(version: string = process.versions.node): string {
  const major = Number(version.split('.')[0]);
  // The newest Vercel runtime not newer than the building Node (odd releases map to the LTS line below them).
  const supported = VERCEL_NODE_MAJORS.filter((m) => m <= major);
  return `nodejs${supported.length ? Math.max(...supported) : VERCEL_NODE_MAJORS[0]}.x`;
}

/** Node.js majors Vercel Functions run (Build Output API `runtime: nodejs<major>.x`). */
export const VERCEL_NODE_MAJORS = [22, 24, 26] as const;

/**
 * Bundles HypDriv's Routing Middleware (config + final manifest + runtime) into one ESM file for a Build Output
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
      `import { createVercelMiddleware } from '@hypdriv/vite/vercel-middleware';`,
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
 * HypDriv's header routes, clean URLs for multi-page builds, the SPA fallback, and (by default) HypDriv's Routing
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
  if (input.middleware) {
    const funcDir = join(out, 'functions', '_hypdriv', 'middleware.func');
    await buildVercelMiddleware({
      root: input.root,
      funcDir,
      config: input.config,
      manifest: input.manifest,
    });
    const immutable = input.manifest.staticFiles.immutablePrefixes.map((p) => p.replace(/^\/|\/$/g, ''));
    const exclude = immutable.length
      ? `(?!${immutable.map((p) => `${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).join('|')})`
      : '';
    routes.push({
      src: `^/${exclude}.*$`,
      middlewarePath: '_hypdriv/middleware',
      middlewareRawSrc: [`/${exclude ? `(${exclude}.*)` : '(.*)'}`],
      continue: true,
      override: true,
    });
  }
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
  input.log.info(`hypdriv: Vercel Build Output written → ${relative(input.root, out)}`);
  return out;
}

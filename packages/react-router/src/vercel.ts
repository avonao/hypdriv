import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { mergeVercelRoutes, type StaticHeaderRule, type VercelRoute } from '@hypdriv/build';
import { type HypManifest, type Logger, routePatternToRegex } from '@hypdriv/core';
import {
  buildVercelMiddleware,
  type LoadedHypConfig,
  PRIVATE_BUILD_FILES,
  vercelNodeRuntime,
} from '@hypdriv/vite';
import { type RouteManifestEntryLike, routePath, routePattern } from './routes';

/** Files of a client build that only configure other platforms. */
const PLATFORM_FILES = new Set(['_headers', '_redirects', '_routes.json', '.assetsignore']);

/** The launcher HypDriv writes next to each server bundle: the bundle's default handler, or React Router's. */
export const VERCEL_LAUNCHER = 'hypdriv-vercel.mjs';

/** Records the functions a previous HypDriv run wrote, so a rebuild replaces them. */
const FUNCTIONS_RECORD = '.hypdriv-functions.json';

/** A server bundle of the build (React Router `serverBundles`, or the single default bundle). */
export interface ServerBundleInfo {
  id: string;
  /** Server build file relative to the project root (`build/server/index.js`). */
  file: string;
  /** Function settings (`@vercel/react-router`'s route `config`: memory, maxDuration, regions, runtime). */
  config?: Record<string, unknown>;
}

/** React Router's build manifest as `buildEnd` receives it. */
export interface BuildManifestLike {
  routes: Record<string, RouteManifestEntryLike>;
  serverBundles?: Record<string, { id: string; file: string; config?: Record<string, unknown> }>;
  routeIdToServerBundleId?: Record<string, string>;
}

/**
 * Function settings of a server bundle: the bundle's own `config` (set by `@vercel/react-router`'s `buildEnd`) or,
 * since preset `buildEnd` hooks run concurrently, the settings `@vercel/react-router` encodes in the bundle id
 * (`<runtime>_<base64url(JSON)>`).
 */
export function bundleConfig(bundle: {
  id: string;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  if (bundle.config && Object.keys(bundle.config).length) return bundle.config;
  const at = bundle.id.indexOf('_');
  if (at < 0) return {};
  try {
    const decoded = JSON.parse(Buffer.from(bundle.id.slice(at + 1), 'base64url').toString('utf8')) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The server bundles of a build: React Router's `serverBundles`, or the single `build/server/<serverBuildFile>`. */
export function serverBundlesOf(input: {
  root: string;
  serverDir: string;
  serverBuildFile: string;
  buildManifest?: BuildManifestLike | undefined;
}): ServerBundleInfo[] {
  const bundles = input.buildManifest?.serverBundles;
  if (bundles && Object.keys(bundles).length) {
    return Object.values(bundles).map((b) => ({ id: b.id, file: b.file, config: bundleConfig(b) }));
  }
  return [
    {
      id: 'index',
      file: relative(input.root, join(input.serverDir, input.serverBuildFile)).replace(/\\/g, '/'),
    },
  ];
}

/** The directory nft traces from: the workspace root (monorepos keep dependencies above the app). */
export function workspaceRoot(root: string): string {
  let dir = resolve(root);
  for (;;) {
    if (
      existsSync(join(dir, 'pnpm-workspace.yaml')) ||
      existsSync(join(dir, 'lerna.json')) ||
      existsSync(join(dir, '.git'))
    )
      return dir;
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch {
        // not a workspace root
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(root);
    dir = parent;
  }
}

function commonAncestor(paths: string[]): string {
  if (!paths.length) return parse(process.cwd()).root;
  let parts = paths[0]!.split(sep);
  for (const p of paths.slice(1)) {
    const other = p.split(sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(sep) || sep;
}

/**
 * Copies the files a Node.js entry needs into a Vercel function directory, traced with `@vercel/nft` (the tracer
 * Vercel's own builders use): paths keep their layout below the common ancestor, symlinks (pnpm) are recreated.
 * Returns the handler path relative to the function directory.
 */
export async function traceFunctionFiles(input: {
  entry: string;
  funcDir: string;
  base: string;
  processCwd: string;
}): Promise<{ handler: string; files: number }> {
  const { nodeFileTrace } = await import('@vercel/nft');
  const traced = await nodeFileTrace([input.entry], { base: input.base, processCwd: input.processCwd });
  const absolute = new Set<string>();
  for (const file of traced.fileList) absolute.add(isAbsolute(file) ? file : join(input.base, file));
  absolute.add(input.entry);
  // Symlink targets are part of the function too.
  const all = new Set(absolute);
  for (const file of absolute) {
    try {
      all.add(realpathSync(file));
    } catch {
      // dangling: skipped below
    }
  }
  const ancestor = commonAncestor([...all].map((f) => dirname(f)));
  const destOf = (file: string) => join(input.funcDir, relative(ancestor, file));
  let files = 0;
  for (const file of [...all].sort()) {
    let stats: ReturnType<typeof statSync>;
    let real: string;
    try {
      stats = statSync(file);
      real = realpathSync(file);
    } catch {
      continue;
    }
    const dest = destOf(file);
    mkdirSync(dirname(dest), { recursive: true });
    if (real !== file) {
      if (existsSync(dest)) continue;
      symlinkSync(relative(dirname(dest), destOf(real)), dest, stats.isDirectory() ? 'dir' : 'file');
    } else if (stats.isFile()) {
      copyFileSync(file, dest);
      files++;
    } else if (stats.isDirectory()) {
      mkdirSync(dest, { recursive: true });
    }
  }
  return { handler: relative(ancestor, input.entry).replace(/\\/g, '/'), files };
}

/** Source of the launcher written next to a server bundle. */
export function launcherSource(serverBuildFile: string): string {
  return [
    '// Generated by @hypdriv/react-router: the Vercel function entry of this server bundle.',
    `import * as build from ${JSON.stringify(`./${serverBuildFile}`)};`,
    "import { createRequestHandler, RouterContextProvider } from 'react-router';",
    '',
    '// HypDriv server entry: the default export runs the Drivetrain around React Router (every request).',
    "const handler = typeof build.default === 'function'",
    '  ? build.default',
    "  : ((rr) => (request) => rr(request, new RouterContextProvider()))(createRequestHandler(build, 'production'));",
    '',
    'export default handler;',
    '',
  ].join('\n');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex (Build Output `src`) matching a list of exact paths. */
export function pathsSource(paths: string[]): string {
  const unique = [...new Set(paths)].sort();
  return `^(?:${unique.map(escapeRegex).join('|')})$`;
}

/** Specificity of a canonical pattern: static segments first, catch-alls last. */
function specificity(pattern: string): number[] {
  return pattern
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith('[[...') ? 0 : seg.startsWith('[...') ? 1 : seg.startsWith('[') ? 2 : 3));
}

function compareSpecificity(a: string, b: string): number {
  const x = specificity(a);
  const y = specificity(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? -1;
    const q = y[i] ?? -1;
    if (p !== q) return q - p;
  }
  return a.localeCompare(b);
}

/** A Build Output function route for a canonical pattern and its `.data` requests. */
export function functionRoutes(pattern: string, dest: string): VercelRoute[] {
  const regex = routePatternToRegex(pattern);
  const body = regex.replace(/^\^/, '').replace(/\(\?:\/\)\?\$$/, '');
  const data = pattern === '/' ? '^/(?:_root|_)\\.data$' : `^${body}(?:/_)?\\.data$`;
  return [
    { src: data, dest },
    { src: regex, dest },
  ];
}

export interface ReactRouterVercelOutputInput {
  root: string;
  clientDir: string;
  /** `build/server`. */
  serverDir: string;
  serverBuildFile: string;
  buildManifest?: BuildManifestLike | undefined;
  /** `reactRouterConfig.routes`. */
  routes: Record<string, RouteManifestEntryLike>;
  basename: string;
  /** False for single-page apps (`ssr: false`): no functions. */
  ssr: boolean;
  /** Public path of the SPA fallback document (`/__spa-fallback.html`, `/index.html`). */
  spaShell: string | null;
  /** Prerendered documents: public path of the file (`/about/index.html`) and the URL path (`/about`). */
  documents: Array<{ file: string; pathname: string }>;
  /** Prerendered data and resource files (`/about.data`, `/api/static.json`). */
  staticPaths: string[];
  rules: StaticHeaderRule[];
  manifest: HypManifest;
  config: LoadedHypConfig;
  /** Build HypDriv's Routing Middleware for the statically served paths (default true). */
  middleware: boolean;
  frameworkVersion: string;
  log: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Writes the Vercel Build Output (`.vercel/output`) for a React Router build: the client build as static files,
 * HypDriv's header rules before the filesystem, prerendered documents rewritten for GET/HEAD, one Node.js function
 * per server bundle (traced with `@vercel/nft`; `@vercel/react-router` route `config` honoured), and HypDriv's
 * Routing Middleware in front of everything Vercel serves statically. `vercel build` deploys it as is.
 */
export async function writeReactRouterVercelOutput(input: ReactRouterVercelOutputInput): Promise<{
  dir: string;
  functions: string[];
  routes: VercelRoute[];
}> {
  const out = join(input.root, '.vercel', 'output');
  mkdirSync(out, { recursive: true });
  // `vercel build` may already have written other builders' output (a root `middleware.ts`): replace only ours.
  const record = join(out, FUNCTIONS_RECORD);
  if (existsSync(record)) {
    try {
      for (const fn of JSON.parse(readFileSync(record, 'utf8')) as string[])
        rmSync(join(out, 'functions', `${fn}.func`), { recursive: true, force: true });
    } catch {
      // unreadable record: functions are rewritten below
    }
  }
  const staticDir = join(out, 'static');
  rmSync(staticDir, { recursive: true, force: true });
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

  const functions: string[] = [];
  const functionRouteList: VercelRoute[] = [];
  if (input.ssr) {
    const bundles = serverBundlesOf(input);
    const base = workspaceRoot(input.root);
    const runtime = vercelNodeRuntime();
    const nameOf = (bundle: ServerBundleInfo) => (bundles.length === 1 ? 'index' : bundle.id);
    for (const bundle of bundles) {
      const settings = bundleConfig(bundle);
      if (settings.runtime === 'edge')
        throw new Error(
          `hypdriv: the server bundle "${bundle.id}" asks for the Edge runtime; HypDriv runs React Router on Vercel's Node.js runtime (Fluid compute). Remove \`runtime: 'edge'\` from the route's \`config\`.`,
        );
      const serverFile = resolve(input.root, bundle.file);
      if (!existsSync(serverFile)) throw new Error(`hypdriv: server bundle not found: ${bundle.file}`);
      const launcher = join(dirname(serverFile), VERCEL_LAUNCHER);
      writeFileSync(launcher, launcherSource(parse(serverFile).base));
      const name = nameOf(bundle);
      const funcDir = join(out, 'functions', `${name}.func`);
      rmSync(funcDir, { recursive: true, force: true });
      mkdirSync(funcDir, { recursive: true });
      const { handler, files } = await traceFunctionFiles({
        entry: launcher,
        funcDir,
        base,
        processCwd: input.root,
      });
      const vcConfig: Record<string, unknown> = {
        runtime,
        handler,
        launcherType: 'Nodejs',
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
        useWebApi: true,
        operationType: 'SSR',
        framework: { slug: 'react-router', version: input.frameworkVersion },
      };
      if (typeof settings.memory === 'number') vcConfig.memory = settings.memory;
      if (typeof settings.maxDuration === 'number') vcConfig.maxDuration = settings.maxDuration;
      if (Array.isArray(settings.regions)) vcConfig.regions = settings.regions;
      writeFileSync(join(funcDir, '.vc-config.json'), `${JSON.stringify(vcConfig, null, 2)}\n`);
      functions.push(name);
      input.log.info(`hypdriv: Vercel function ${name} (${files} files traced)`);
    }

    if (bundles.length === 1) {
      functionRouteList.push({ src: '^/.*$', dest: '/index' });
    } else {
      // One route per React Router route to the function of its bundle; everything else (404s, the lazy route
      // discovery manifest) to the bundle of the index route.
      const byBundle = new Map(bundles.map((b) => [b.id, `/${nameOf(b)}`]));
      const entries: Array<{ pattern: string; dest: string }> = [];
      for (const [routeId, bundleId] of Object.entries(input.buildManifest?.routeIdToServerBundleId ?? {})) {
        const route = input.routes[routeId];
        const dest = byBundle.get(bundleId);
        if (!route || !dest) continue;
        const pattern = routePattern(routePath(input.routes, routeId), input.basename);
        if (!entries.some((e) => e.pattern === pattern)) entries.push({ pattern, dest });
      }
      entries.sort((a, b) => compareSpecificity(a.pattern, b.pattern));
      for (const { pattern, dest } of entries) functionRouteList.push(...functionRoutes(pattern, dest));
      const fallback =
        entries.find((e) => e.pattern === routePattern('', input.basename))?.dest ??
        `/${nameOf(bundles[0]!)}`;
      functionRouteList.push({ src: '^/.*$', dest: fallback });
    }
  }
  writeFileSync(record, `${JSON.stringify(functions)}\n`);

  // Routes: skew protection → HypDriv header rules → Routing Middleware → prerendered documents → filesystem →
  // functions (or the SPA fallback). Header rules precede the document rewrites so they match the URL path.
  const routes: VercelRoute[] = [];
  const headerRoutes = mergeVercelRoutes([{ handle: 'filesystem' }], input.rules).slice(0, -1);
  const documentPaths = new Set(input.documents.flatMap((d) => [d.pathname, `${d.pathname}/`]));
  for (const route of headerRoutes) {
    // A document's policy belongs to the static file; other methods reach the function, which sets its own.
    const csp = Object.keys(route.headers ?? {}).some((k) => k.startsWith('content-security-policy'));
    const exact = /^\^(.*)\$$/.exec(route.src ?? '')?.[1]?.replace(/\\(.)/g, '$1');
    if (input.ssr && csp && exact && documentPaths.has(exact)) route.methods = ['GET', 'HEAD'];
  }
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (process.env.VERCEL_SKEW_PROTECTION_ENABLED === '1' && deploymentId) {
    routes.push({
      src: '/(.*)',
      has: [{ type: 'header', key: 'Sec-Fetch-Dest', value: 'document' }],
      headers: { 'Set-Cookie': `__vdpl=${deploymentId}; Path=/; SameSite=Strict; Secure; HttpOnly` },
      continue: true,
    });
  }
  routes.push(...headerRoutes);
  const immutable = input.manifest.staticFiles.immutablePrefixes;
  if (input.middleware) {
    const funcDir = join(out, 'functions', '_hypdriv', 'middleware.func');
    await buildVercelMiddleware({
      root: input.root,
      funcDir,
      config: input.config,
      manifest: input.manifest,
    });
    let src: string;
    let raw: string[];
    if (input.ssr) {
      // Functions run the full pipeline themselves; the middleware covers what Vercel serves statically.
      const paths = new Set<string>();
      for (const doc of input.documents) {
        paths.add(doc.pathname);
        if (doc.pathname !== '/') paths.add(`${doc.pathname}/`);
        paths.add(doc.file);
      }
      for (const p of input.staticPaths) paths.add(p);
      raw = [...paths].sort();
      src = paths.size ? pathsSource(raw) : '';
    } else {
      const exclude = immutable.map((p) => `${escapeRegex(p.replace(/^\/|\/$/g, ''))}/`);
      src = `^/${exclude.length ? `(?!${exclude.join('|')})` : ''}.*$`;
      raw = ['/(.*)'];
    }
    if (src) {
      routes.push({
        src,
        middlewarePath: '_hypdriv/middleware',
        middlewareRawSrc: raw,
        continue: true,
        override: true,
      });
    }
  }
  for (const doc of input.documents) {
    if (input.spaShell && doc.file === input.spaShell) continue;
    const src = doc.pathname === '/' ? '^/$' : `^${escapeRegex(doc.pathname)}/?$`;
    routes.push({ src, dest: doc.file, methods: ['GET', 'HEAD'] });
  }
  routes.push({ handle: 'filesystem' });
  if (input.ssr) routes.push(...functionRouteList);
  else if (input.spaShell)
    // Deep links of the single-page app; `/api/*` and file-like paths stay 404s instead of getting the shell.
    routes.push({ src: '^/(?!api(?:/|$))(?!.*\\.[A-Za-z0-9]+$).*$', dest: input.spaShell, check: true });

  const framework = { version: input.frameworkVersion };
  writeFileSync(join(out, 'config.json'), `${JSON.stringify({ version: 3, routes, framework }, null, 2)}\n`);
  input.log.info(`hypdriv: Vercel Build Output written → ${relative(input.root, out)}`);
  return { dir: out, functions, routes };
}

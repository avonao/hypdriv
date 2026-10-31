import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { FrameworkName, HypManifest } from '@hypdriv/core';
import {
  detectPackageManager,
  findConfigFile,
  findProjectRoot,
  findRepoRoot,
  installedVersion,
  manifestPath,
  type PackageInfo,
  readManifestSync,
  readPackageJson,
} from '@hypdriv/core/node';
import { parseVersion } from './semver';
import { type SourceScanResult, scanSources } from './source-scan';
import { exists, firstExisting, isDirectory, readJsonFile, readText } from './util/fs';
import { parseVercelJson, readVercelTs, type VercelConfig } from './vercel-config';
import { parseJsonc, parseWranglerConfig, type WranglerConfig, type WranglerFormat } from './wrangler-config';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** Deployment target. `node` = Next.js without Cloudflare or Vercel tooling (`next start`, containers). */
export type DeployPlatform = 'cloudflare' | 'vercel' | 'node' | 'unknown';
export const DEPLOY_PLATFORMS: readonly DeployPlatform[] = ['cloudflare', 'vercel', 'node', 'unknown'];

/** Hypdriv's runtime package per platform (the Worker shell, the Vercel runtime, none for plain Node). */
export const PLATFORM_RUNTIME_PACKAGE: Record<DeployPlatform, string | null> = {
  cloudflare: '@hypdriv/cloudflare',
  vercel: '@hypdriv/vercel',
  node: null,
  unknown: null,
};

/** The application framework Hypdriv integrates with (`unknown` when none is recognised). */
export type ProjectFramework = FrameworkName | 'unknown';

/** Hypdriv's integration package per framework. */
export const FRAMEWORK_INTEGRATION: Record<FrameworkName, string> = {
  next: 'hypdriv',
  vinext: '@hypdriv/vinext',
  'react-router': '@hypdriv/react-router',
  'tanstack-start': '@hypdriv/tanstack-start',
  astro: '@hypdriv/astro',
  sveltekit: '@hypdriv/sveltekit',
  nuxt: '@hypdriv/nuxt',
  vite: '@hypdriv/vite',
};

/** Display names. */
export const FRAMEWORK_LABEL: Record<ProjectFramework, string> = {
  next: 'Next.js',
  vinext: 'vinext',
  'react-router': 'React Router',
  'tanstack-start': 'TanStack Start',
  astro: 'Astro',
  sveltekit: 'SvelteKit',
  nuxt: 'Nuxt',
  vite: 'Vite',
  unknown: 'an unknown framework',
};

export interface FrameworkInfo {
  name: ProjectFramework;
  /** Installed (or declared) framework version. */
  version: string | null;
  /** The Hypdriv integration package for the framework. */
  integration: string | null;
  /** Installed version of the integration package. */
  integrationInstalled: string | null;
  /** The framework's config file, when it has one (`vite.config.ts`, `astro.config.mjs`, `nuxt.config.ts`…). */
  configFile: string | null;
  /** Whether the config file references the integration (regex based; files are never executed). */
  registered: boolean | null;
}

/** Framework detection order: the most specific dependency wins (vinext before next, metaframeworks before vite). */
const FRAMEWORK_DEPENDENCIES: Array<[FrameworkName, string]> = [
  ['vinext', 'vinext'],
  ['next', 'next'],
  ['tanstack-start', '@tanstack/react-start'],
  ['react-router', '@react-router/dev'],
  ['astro', 'astro'],
  ['sveltekit', '@sveltejs/kit'],
  ['nuxt', 'nuxt'],
  ['vite', 'vite'],
];

const FRAMEWORK_CONFIG_FILES: Record<FrameworkName, string[]> = {
  next: ['next.config.ts', 'next.config.mts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'],
  vinext: ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'],
  'react-router': ['react-router.config.ts', 'react-router.config.js', 'vite.config.ts', 'vite.config.js'],
  'tanstack-start': ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'],
  astro: ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js'],
  sveltekit: ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'svelte.config.js'],
  nuxt: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'],
  vite: ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'],
};

/** Detects the framework from the package's dependencies and its config file. */
export function detectFramework(root: string, pkg: PackageInfo | null): FrameworkInfo {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const found = FRAMEWORK_DEPENDENCIES.find(([, dep]) => dep in deps || installedVersion(root, dep) !== null);
  if (!found)
    return {
      name: 'unknown',
      version: null,
      integration: null,
      integrationInstalled: null,
      configFile: null,
      registered: null,
    };
  const [name, dep] = found;
  const integration = FRAMEWORK_INTEGRATION[name];
  const configFile = firstExisting(root, FRAMEWORK_CONFIG_FILES[name]);
  const source = configFile ? (readText(configFile) ?? '') : '';
  const pattern =
    name === 'next'
      ? /\bwithHypDriv\b/
      : new RegExp(
          `['"](?:${integration.replace(/[/@.-]/g, (c) => `\\${c}`)}|hypdriv\\/${name})(?:\\/[\\w-]+)?['"]`,
        );
  return {
    name,
    version: installedVersion(root, dep) ?? (deps[dep] as string | undefined) ?? null,
    integration,
    integrationInstalled:
      installedVersion(root, integration) ??
      (name === 'next' ? installedVersion(root, '@hypdriv/next') : null),
    configFile,
    registered: configFile ? pattern.test(source) : null,
  };
}

export interface PlatformDetection {
  platform: DeployPlatform;
  /** `--platform` forced the value. */
  explicit: boolean;
  /** Evidence per platform, e.g. `wrangler.jsonc`, `VERCEL env`. */
  signals: { cloudflare: string[]; vercel: string[] };
}

export interface VercelInfo {
  configFile: string | null;
  format: 'json' | 'ts' | null;
  config: VercelConfig | null;
  parseError: string | null;
  /** `.vercel/project.json` exists (`vercel link` / `vercel pull`). */
  linked: boolean;
  /**
   * The directory holding this app's `.vercel` link: the app root, or — in a monorepo, where `vercel link`,
   * `vercel pull` and `vercel build` run at the repository root — the repository root when its
   * `.vercel/project.json` names this app as the project's root directory. `null` when not linked.
   */
  linkDir: string | null;
  /** `.vercel/output` (Build Output API) exists. */
  outputDir: string | null;
  /** Installed `vercel` CLI package version. */
  cli: string | null;
}

export interface EnvFileInfo {
  file: string;
  keys: string[];
}

export interface VersionInfo {
  /** Version from node_modules, or null when not installed. */
  installed: string | null;
  /** Declared range in package.json (dependencies or devDependencies), or null. */
  range: string | null;
}

export interface NextConfigAnalysis {
  file: string;
  module: 'esm' | 'cjs';
  /** `withHypDriv` is imported. */
  importsWithHypDriv: boolean;
  /** The default export (or `module.exports`) is wrapped in `withHypDriv(`. */
  wrapped: boolean;
  adapterPath: string | null;
  output: string | null;
  imagesLoader: string | null;
  imagesLoaderFile: string | null;
  imagesUnoptimized: boolean;
  cacheComponents: boolean | null;
  setsDeploymentId: boolean;
  initOpenNextDev: boolean;
  basePath: string | null;
  defaultExport: 'identifier' | 'object' | 'call' | 'function' | 'cjs' | 'none';
}

export interface WranglerInfo extends VersionInfo {
  configFile: string | null;
  /** The environment (`--env`) the config was resolved for, or null for the top level. */
  environment: string | null;
  format: WranglerFormat | null;
  config: WranglerConfig | null;
  parseError: string | null;
}

export interface DevVarsInfo {
  file: string | null;
  exampleFile: string | null;
  /** Variable names present in `.dev.vars` (values are never exposed). */
  keys: string[];
  /** Value lengths by key (for strength checks without exposing values). */
  lengths: Record<string, number>;
  gitignored: boolean;
}

export interface PurserInfo {
  installed: string | null;
  tokensFile: string | null;
  strikeScript: boolean;
}

export interface ProjectInfo {
  root: string;
  repoRoot: string;
  platform: DeployPlatform;
  platformDetection: PlatformDetection;
  /** The application framework and its Hypdriv integration. */
  framework: FrameworkInfo;
  vercel: VercelInfo;
  /** `.env*` files (Next.js / Vercel) with their variable names; values are never read into memory beyond parsing. */
  envFiles: EnvFileInfo[];
  /** `tsconfig.json` excludes `hypdriv.worker.ts` (needed before `.open-next/` exists). */
  tsconfigExcludesWorker: boolean | null;
  /** Running inside the Hypdriv monorepo itself. */
  inHypDrivMonorepo: boolean;
  /** `pnpm-workspace.yaml` exists at the repo root. */
  workspace: boolean;
  packageManager: PackageManager;
  packageJson: PackageInfo | null;
  name: string;
  srcDir: boolean;
  router: { app: boolean; pages: boolean };
  node: string;
  typescript: VersionInfo & { major: number | null };
  next: VersionInfo;
  react: VersionInfo;
  opennext: VersionInfo;
  wrangler: WranglerInfo;
  cloudflareConfigFile: string | null;
  nextConfig: NextConfigAnalysis | null;
  proxyFile: string | null;
  middlewareFile: string | null;
  instrumentationFile: string | null;
  hypdrivConfigFile: string | null;
  hypdrivWorkerFile: string | null;
  openNextConfigFile: string | null;
  openNextWorkerFile: string | null;
  nextBuild: { dir: string; buildId: string | null } | null;
  manifest: { file: string; data: HypManifest | null; error: string | null } | null;
  headersFile: string | null;
  devVars: DevVarsInfo;
  purser: PurserInfo;
  hypdriv: { installed: string | null; range: string | null; packages: Record<string, string> };
  layoutFile: string | null;
  sources: SourceScanResult;
}

const NEXT_CONFIG_FILES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
];
const PROXY_FILES = [
  'proxy.ts',
  'proxy.mts',
  'proxy.js',
  'proxy.mjs',
  'src/proxy.ts',
  'src/proxy.mts',
  'src/proxy.js',
  'src/proxy.mjs',
];
const MIDDLEWARE_FILES = [
  'middleware.ts',
  'middleware.js',
  'middleware.mts',
  'src/middleware.ts',
  'src/middleware.js',
];
const INSTRUMENTATION_FILES = [
  'instrumentation.ts',
  'instrumentation.js',
  'src/instrumentation.ts',
  'src/instrumentation.js',
];
const WORKER_FILES = ['hypdriv.worker.ts', 'hypdriv.worker.mts', 'hypdriv.worker.js', 'hypdriv.worker.mjs'];
const OPEN_NEXT_CONFIG_FILES = [
  'open-next.config.ts',
  'open-next.config.mts',
  'open-next.config.js',
  'open-next.config.mjs',
];
const LAYOUT_FILES = [
  'app/layout.tsx',
  'app/layout.jsx',
  'app/layout.js',
  'src/app/layout.tsx',
  'src/app/layout.jsx',
  'src/app/layout.js',
];
export const TOKENS_FILE_CANDIDATES = [
  'lib/tokens.ts',
  'lib/tokens.js',
  'src/lib/tokens.ts',
  'app/tokens.ts',
  'tokens.ts',
];

function declaredRange(pkg: PackageInfo | null, name: string): string | null {
  if (!pkg) return null;
  return pkg.dependencies[name] ?? pkg.devDependencies[name] ?? null;
}

function versionInfo(root: string, pkg: PackageInfo | null, name: string): VersionInfo {
  return { installed: installedVersion(root, name), range: declaredRange(pkg, name) };
}

/** Static analysis of `next.config.*` (regex based; the file is never executed). */
export function analyzeNextConfig(file: string, source: string): NextConfigAnalysis {
  const isCjs = /module\.exports\s*=/.test(source) && !/export\s+default/.test(source);
  const str = (re: RegExp): string | null => {
    const m = re.exec(source);
    return m?.[1] ?? null;
  };
  const bool = (re: RegExp): boolean | null => {
    const m = re.exec(source);
    if (!m) return null;
    return m[1] === 'true';
  };
  let defaultExport: NextConfigAnalysis['defaultExport'] = 'none';
  const def = /export\s+default\s+([\s\S]{0,40})/.exec(source);
  if (def) {
    const head = def[1]!.trimStart();
    if (/^(?:async\s+)?function\b/.test(head)) defaultExport = 'function';
    else if (head.startsWith('{')) defaultExport = 'object';
    else if (/^[A-Za-z_$][\w$]*\s*\(/.test(head)) defaultExport = 'call';
    else defaultExport = 'identifier';
  } else if (isCjs) defaultExport = 'cjs';
  const imagesBlock = /images\s*:\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
  return {
    file,
    module: isCjs ? 'cjs' : 'esm',
    importsWithHypDriv:
      /\bwithHypDriv\b/.test(source) &&
      /(?:from\s+['"](?:@hypdriv\/next\/config|hypdriv\/config|hypdriv|@hypdriv\/next)['"]|require\(['"](?:@hypdriv\/next\/config|hypdriv\/config|hypdriv)['"]\))/.test(
        source,
      ),
    wrapped: /(?:export\s+default|module\.exports\s*=)\s*withHypDriv\s*\(/.test(source),
    adapterPath: str(/\badapterPath\s*:\s*['"`]([^'"`]+)['"`]/),
    output: str(/\boutput\s*:\s*['"`]([^'"`]+)['"`]/),
    imagesLoader: /loader\s*:\s*['"`]([^'"`]+)['"`]/.exec(imagesBlock)?.[1] ?? null,
    imagesLoaderFile: /loaderFile\s*:\s*['"`]([^'"`]+)['"`]/.exec(imagesBlock)?.[1] ?? null,
    imagesUnoptimized: /unoptimized\s*:\s*true/.test(imagesBlock),
    cacheComponents: bool(/\bcacheComponents\s*:\s*(true|false)/),
    setsDeploymentId: /\bdeploymentId\s*:/.test(source),
    initOpenNextDev: /initOpenNextCloudflareForDev\s*\(/.test(source),
    basePath: str(/\bbasePath\s*:\s*['"`]([^'"`]+)['"`]/),
    defaultExport,
  };
}

function readDevVars(root: string): DevVarsInfo {
  const file = exists(join(root, '.dev.vars')) ? join(root, '.dev.vars') : null;
  const exampleFile = exists(join(root, '.dev.vars.example')) ? join(root, '.dev.vars.example') : null;
  const keys: string[] = [];
  const lengths: Record<string, number> = {};
  if (file) {
    const text = readText(file) ?? '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line
        .slice(0, eq)
        .trim()
        .replace(/^export\s+/, '');
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1);
      keys.push(key);
      lengths[key] = value.length;
    }
  }
  const gitignore =
    readText(join(root, '.gitignore')) ?? readText(join(findRepoRoot(root), '.gitignore')) ?? '';
  const gitignored = gitignore
    .split(/\r?\n/)
    .some((l) => /^\s*\.dev\.vars(\*|\.\*)?\s*$/.test(l) || /^\s*\.dev\.vars\*?\s*$/.test(l));
  return { file, exampleFile, keys, lengths, gitignored };
}

function readWrangler(
  root: string,
  pkg: PackageInfo | null,
  override?: string | null,
  environment: string | null = null,
): WranglerInfo {
  const base = { ...versionInfo(root, pkg, 'wrangler'), environment };
  if (override) {
    const format: WranglerFormat = override.endsWith('.toml')
      ? 'toml'
      : override.endsWith('.json')
        ? 'json'
        : 'jsonc';
    const source = readText(override);
    if (source === null)
      return {
        ...base,
        configFile: override,
        format,
        config: null,
        parseError: `${override} could not be read`,
      };
    try {
      return {
        ...base,
        configFile: override,
        format,
        config: parseWranglerConfig(source, format, environment ?? undefined),
        parseError: null,
      };
    } catch (err) {
      return { ...base, configFile: override, format, config: null, parseError: (err as Error).message };
    }
  }
  const candidates: Array<[string, WranglerFormat]> = [
    ['wrangler.jsonc', 'jsonc'],
    ['wrangler.json', 'json'],
    ['wrangler.toml', 'toml'],
  ];
  // A Vite config can point the Cloudflare plugin elsewhere (`cloudflare({ configPath: './cloudflare/wrangler.jsonc' })`).
  for (const viteConfig of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    const source = readText(join(root, viteConfig));
    const m = source
      ? /configPath\s*:\s*(?:[^,'"`]*\?\?\s*)?['"]([^'"]+\.(jsonc|json|toml))['"]/.exec(source)
      : null;
    if (m) candidates.push([m[1]!, m[2] as WranglerFormat]);
  }
  for (const [name, format] of candidates) {
    const file = join(root, name);
    if (!exists(file)) continue;
    try {
      return {
        ...base,
        configFile: file,
        format,
        config: parseWranglerConfig(readFileSync(file, 'utf8'), format, environment ?? undefined),
        parseError: null,
      };
    } catch (err) {
      return { ...base, configFile: file, format, config: null, parseError: (err as Error).message };
    }
  }
  return { ...base, configFile: null, format: null, config: null, parseError: null };
}

function readManifestInfo(root: string): ProjectInfo['manifest'] {
  const file = manifestPath(root);
  if (!exists(file)) return null;
  try {
    return { file, data: readManifestSync(root), error: null };
  } catch (err) {
    return { file, data: null, error: (err as Error).message };
  }
}

function detectHypDrivMonorepo(repoRoot: string): boolean {
  const pkg = readJsonFile<{ name?: string }>(join(repoRoot, 'package.json'));
  if (pkg?.name === 'hypdriv-monorepo') return true;
  const cli = readJsonFile<{ name?: string }>(join(repoRoot, 'packages', 'cli', 'package.json'));
  return cli?.name === '@hypdriv/cli';
}

const ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.vercel/.env.development.local',
  '.vercel/.env.preview.local',
  '.vercel/.env.production.local',
];

/** Variable names declared in a dotenv-style file. */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

function readEnvFiles(root: string, vercelLinkDir: string | null): EnvFileInfo[] {
  const out: EnvFileInfo[] = [];
  for (const name of ENV_FILES) {
    // `vercel pull` writes `.vercel/.env.*.local` next to the link, which is the repository root in monorepos.
    const base = name.startsWith('.vercel/') && vercelLinkDir ? vercelLinkDir : root;
    const path = join(base, name);
    const text = readText(path);
    if (text !== null)
      out.push({ file: base === root ? name : relative(root, path), keys: parseEnvKeys(text) });
  }
  return out;
}

/** Where this app's `.vercel` link lives (see `VercelInfo.linkDir`). */
export function vercelLinkDir(root: string, repoRoot: string): string | null {
  if (exists(join(root, '.vercel', 'project.json'))) return root;
  if (repoRoot === root) return null;
  const text = readText(join(repoRoot, '.vercel', 'project.json'));
  if (text === null) return null;
  try {
    const link = JSON.parse(text) as { settings?: { rootDirectory?: string | null } };
    const dir = link.settings?.rootDirectory?.replace(/^\.?\/+|\/+$/g, '');
    return dir && dir === relative(repoRoot, root).split(sep).join('/') ? repoRoot : null;
  } catch {
    return null;
  }
}

function readVercel(root: string, linkDir: string | null): VercelInfo {
  const json = join(root, 'vercel.json');
  const ts = firstExisting(root, ['vercel.ts', 'vercel.mts']);
  const base: VercelInfo = {
    configFile: null,
    format: null,
    config: null,
    parseError: null,
    linked: linkDir !== null,
    linkDir,
    // `vercel build` writes the Build Output next to the link; an app-local `.vercel/output` comes first.
    outputDir:
      [root, linkDir]
        .filter((dir): dir is string => dir !== null)
        .map((dir) => join(dir, '.vercel', 'output'))
        .find((dir) => isDirectory(dir)) ?? null,
    cli: installedVersion(root, 'vercel'),
  };
  if (exists(json)) {
    try {
      return {
        ...base,
        configFile: json,
        format: 'json',
        config: parseVercelJson(readFileSync(json, 'utf8')),
      };
    } catch (err) {
      return { ...base, configFile: json, format: 'json', parseError: (err as Error).message };
    }
  }
  if (ts) return { ...base, configFile: ts, format: 'ts', config: readVercelTs(readFileSync(ts, 'utf8')) };
  return base;
}

function tsconfigExcludes(root: string, entry: string): boolean | null {
  const text = readText(join(root, 'tsconfig.json'));
  if (text === null) return null;
  try {
    const doc = parseJsonc(text) as { exclude?: unknown };
    return Array.isArray(doc.exclude) && doc.exclude.some((e) => e === entry || e === `./${entry}`);
  } catch {
    return null;
  }
}

interface PlatformInputs {
  env: Record<string, string | undefined>;
  wranglerConfig: string | null;
  cloudflareConfig: string | null;
  workerFile: string | null;
  opennext: VersionInfo;
  vercel: VercelInfo;
  pkg: PackageInfo | null;
  nextInstalled: boolean;
  frameworkInstalled?: boolean;
}

/**
 * Picks the deployment platform from the project's tooling. A Vercel build environment (`VERCEL`)
 * wins; otherwise the platform with the stronger evidence (config files and adapters weigh more than
 * a linked `.vercel/` folder or incidental `@vercel/*` packages). Ties go to Cloudflare, Hypdriv's
 * reference target.
 */
export function detectPlatform(input: PlatformInputs, forced?: DeployPlatform | null): PlatformDetection {
  const signals: PlatformDetection['signals'] = { cloudflare: [], vercel: [] };
  let cf = 0;
  let vc = 0;
  const name = (file: string) => file.split(/[\\/]/).pop()!;
  if (input.wranglerConfig) {
    signals.cloudflare.push(name(input.wranglerConfig));
    cf += 3;
  }
  if (input.opennext.installed || input.opennext.range) {
    signals.cloudflare.push('@opennextjs/cloudflare');
    cf += 3;
  }
  if (input.cloudflareConfig) {
    signals.cloudflare.push(name(input.cloudflareConfig));
    cf += 2;
  }
  if (input.workerFile) {
    signals.cloudflare.push(name(input.workerFile));
    cf += 2;
  }
  const allDeps = { ...(input.pkg?.dependencies ?? {}), ...(input.pkg?.devDependencies ?? {}) };
  if (allDeps['@cloudflare/vite-plugin']) {
    signals.cloudflare.push('@cloudflare/vite-plugin');
    cf += 2;
  }
  const deps = { ...(input.pkg?.dependencies ?? {}), ...(input.pkg?.devDependencies ?? {}) };
  if (input.env.VERCEL === '1' || input.env.VERCEL === 'true' || input.env.VERCEL_ENV) {
    signals.vercel.push('VERCEL environment');
    vc += 10;
  }
  if (input.vercel.configFile) {
    signals.vercel.push(name(input.vercel.configFile));
    vc += 3;
  }
  if (deps['@hypdriv/vercel']) {
    signals.vercel.push('@hypdriv/vercel');
    vc += 3;
  }
  if (input.vercel.linked) {
    signals.vercel.push('.vercel/project.json');
    vc += 1;
  }
  if (input.vercel.outputDir) {
    signals.vercel.push('.vercel/output');
    vc += 1;
  }
  const vercelDeps = Object.keys(deps).filter((d) => d.startsWith('@vercel/') || d === 'vercel');
  if (vercelDeps.length && cf === 0) {
    signals.vercel.push(...vercelDeps.slice(0, 3));
    vc += 1;
  }
  if (forced) return { platform: forced, explicit: true, signals };
  let platform: DeployPlatform;
  if (vc >= 10) platform = 'vercel';
  else if (cf === 0 && vc === 0)
    platform = input.nextInstalled || input.frameworkInstalled ? 'node' : 'unknown';
  else platform = vc > cf ? 'vercel' : 'cloudflare';
  return { platform, explicit: false, signals };
}

export interface DetectOptions {
  /** Skip the source scan (faster for commands that do not need it). */
  scan?: boolean;
  nodeVersion?: string;
  /** Overrides platform detection (`--platform`). */
  platform?: DeployPlatform | null;
  /** Absolute path of the Wrangler config to read instead of `<root>/wrangler.*` (`--wrangler`). */
  wrangler?: string | null;
  /** Wrangler environment (`env.<name>`) to resolve the config for (`--env`); null = the top level. */
  wranglerEnv?: string | null;
  /** Environment used for platform signals (default: `process.env`). */
  env?: Record<string, string | undefined>;
}

/** Detects everything the commands and doctor checks need to know about a project. Pure reads; never writes. */
export function detectProject(start: string, options: DetectOptions = {}): ProjectInfo {
  const root = findProjectRoot(resolve(start));
  const repoRoot = findRepoRoot(root);
  const pkg = readPackageJson(root);
  const srcDir =
    isDirectory(join(root, 'src')) && !isDirectory(join(root, 'app')) && !isDirectory(join(root, 'pages'));
  const appDir = isDirectory(join(root, 'app')) || isDirectory(join(root, 'src', 'app'));
  const pagesDir = isDirectory(join(root, 'pages')) || isDirectory(join(root, 'src', 'pages'));
  const typescript = versionInfo(root, pkg, 'typescript');
  const buildIdFile = join(root, '.next', 'BUILD_ID');
  const hypdrivPackages: Record<string, string> = {};
  for (const name of [
    'hypdriv',
    '@hypdriv/core',
    '@hypdriv/next',
    '@hypdriv/cloudflare',
    '@hypdriv/vercel',
    '@hypdriv/cli',
    '@hypdriv/security',
    '@hypdriv/purser',
    '@hypdriv/runtime',
    '@hypdriv/vite',
    '@hypdriv/react-router',
    '@hypdriv/tanstack-start',
    '@hypdriv/astro',
    '@hypdriv/sveltekit',
    '@hypdriv/nuxt',
    '@hypdriv/vinext',
  ]) {
    const v = installedVersion(root, name);
    if (v) hypdrivPackages[name] = v;
  }
  const nextConfigFile = firstExisting(root, NEXT_CONFIG_FILES);
  const purserVersion = installedVersion(root, '@avonao/purser');
  const wrangler = readWrangler(root, pkg, options.wrangler, options.wranglerEnv ?? null);
  const linkDir = vercelLinkDir(root, repoRoot);
  const vercel = readVercel(root, linkDir);
  const opennext = versionInfo(root, pkg, '@opennextjs/cloudflare');
  const next = versionInfo(root, pkg, 'next');
  const cloudflareConfigFile = firstExisting(root, [
    'cloudflare.config.ts',
    'cloudflare.config.js',
    'cloudflare.config.mjs',
  ]);
  const hypdrivWorkerFile = firstExisting(root, WORKER_FILES);
  const platformDetection = detectPlatform(
    {
      env: options.env ?? process.env,
      wranglerConfig: wrangler.configFile,
      cloudflareConfig: cloudflareConfigFile,
      workerFile: hypdrivWorkerFile,
      opennext,
      vercel,
      pkg,
      nextInstalled: next.installed !== null || next.range !== null,
      // Any recognised server framework runs on a plain Node host when no platform tooling is present.
      frameworkInstalled: FRAMEWORK_DEPENDENCIES.some(
        ([, dep]) => pkg?.dependencies[dep] || pkg?.devDependencies[dep],
      ),
    },
    options.platform ?? null,
  );
  const framework = detectFramework(root, pkg);
  return {
    root,
    repoRoot,
    platform: platformDetection.platform,
    platformDetection,
    framework,
    vercel,
    envFiles: readEnvFiles(root, linkDir),
    tsconfigExcludesWorker: tsconfigExcludes(root, 'hypdriv.worker.ts'),
    inHypDrivMonorepo: detectHypDrivMonorepo(repoRoot),
    workspace: exists(join(repoRoot, 'pnpm-workspace.yaml')),
    // pnpm-workspace.yaml implies pnpm even before a lockfile exists
    packageManager: ((pm) =>
      pm === 'npm' && !pkg?.packageManager && exists(join(repoRoot, 'pnpm-workspace.yaml')) ? 'pnpm' : pm)(
      detectPackageManager(root),
    ),
    packageJson: pkg,
    name: pkg?.name ?? basename(root),
    srcDir,
    router: { app: appDir, pages: pagesDir },
    node: options.nodeVersion ?? process.versions.node,
    typescript: { ...typescript, major: parseVersion(typescript.installed)?.major ?? null },
    next,
    react: versionInfo(root, pkg, 'react'),
    opennext,
    wrangler,
    cloudflareConfigFile,
    nextConfig: nextConfigFile ? analyzeNextConfig(nextConfigFile, readText(nextConfigFile) ?? '') : null,
    proxyFile: firstExisting(root, PROXY_FILES),
    middlewareFile: firstExisting(root, MIDDLEWARE_FILES),
    instrumentationFile: firstExisting(root, INSTRUMENTATION_FILES),
    hypdrivConfigFile: findConfigFile(root),
    hypdrivWorkerFile,
    openNextConfigFile: firstExisting(root, OPEN_NEXT_CONFIG_FILES),
    openNextWorkerFile: exists(join(root, '.open-next', 'worker.js'))
      ? join(root, '.open-next', 'worker.js')
      : null,
    nextBuild: isDirectory(join(root, '.next'))
      ? { dir: join(root, '.next'), buildId: readText(buildIdFile)?.trim() ?? null }
      : null,
    manifest: readManifestInfo(root),
    headersFile: exists(join(root, 'public', '_headers')) ? join(root, 'public', '_headers') : null,
    devVars: readDevVars(root),
    purser: {
      installed: purserVersion,
      tokensFile: TOKENS_FILE_CANDIDATES.find((c) => exists(join(root, c))) ?? null,
      strikeScript:
        purserVersion !== null &&
        exists(join(findPackageDir(root, '@avonao/purser') ?? '', 'scripts', 'strike-count.js')),
    },
    hypdriv: {
      installed:
        hypdrivPackages.hypdriv ??
        hypdrivPackages['@hypdriv/next'] ??
        (framework.integration ? hypdrivPackages[framework.integration] : undefined) ??
        hypdrivPackages['@hypdriv/core'] ??
        null,
      range:
        declaredRange(pkg, 'hypdriv') ??
        declaredRange(pkg, '@hypdriv/next') ??
        (framework.integration ? declaredRange(pkg, framework.integration) : null) ??
        null,
      packages: hypdrivPackages,
    },
    layoutFile: firstExisting(root, LAYOUT_FILES),
    sources:
      options.scan === false
        ? { filesScanned: 0, truncated: false, edgeRuntime: [], nodeApis: [], revalidation: [] }
        : scanSources(root),
  };
}

/** Directory of an installed package (walks the node_modules chain upwards). */
export function findPackageDir(root: string, name: string): string | null {
  let dir = resolve(root);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (exists(join(candidate, 'package.json'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Command prefix that runs a locally installed binary with the detected package manager. */
export function execCommand(
  pm: PackageManager,
  bin: string,
  args: string[],
): { command: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...args] };
    case 'yarn':
      return { command: 'yarn', args: [bin, ...args] };
    case 'bun':
      return { command: 'bunx', args: [bin, ...args] };
    default:
      return { command: 'npx', args: ['--no-install', bin, ...args] };
  }
}

/** `pnpm add`, `npm install`, ... for display. */
export function installCommand(pm: PackageManager, packages: string[] = [], dev = false): string {
  const list = packages.join(' ');
  switch (pm) {
    case 'pnpm':
      return packages.length ? `pnpm add ${dev ? '-D ' : ''}${list}` : 'pnpm install';
    case 'yarn':
      return packages.length ? `yarn add ${dev ? '-D ' : ''}${list}` : 'yarn install';
    case 'bun':
      return packages.length ? `bun add ${dev ? '-d ' : ''}${list}` : 'bun install';
    default:
      return packages.length ? `npm install ${dev ? '-D ' : ''}${list}` : 'npm install';
  }
}

/** `pnpm run x` / `npm run x` for display. */
export function runScriptCommand(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

/** `npx hypdriv` style invocation for display. */
export function cliInvocation(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm hypdriv';
    case 'yarn':
      return 'yarn hypdriv';
    case 'bun':
      return 'bunx hypdriv';
    default:
      return 'npx hypdriv';
  }
}

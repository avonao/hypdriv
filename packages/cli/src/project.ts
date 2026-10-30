import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { HypManifest } from '@hypdriv/core';
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
import { parseWranglerConfig, type WranglerConfig, type WranglerFormat } from './wrangler-config';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

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
  /** Running inside the HypDriv monorepo itself. */
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

const NEXT_CONFIG_FILES = ['next.config.ts', 'next.config.mts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'];
const PROXY_FILES = ['proxy.ts', 'proxy.mts', 'proxy.js', 'proxy.mjs', 'src/proxy.ts', 'src/proxy.mts', 'src/proxy.js', 'src/proxy.mjs'];
const MIDDLEWARE_FILES = ['middleware.ts', 'middleware.js', 'middleware.mts', 'src/middleware.ts', 'src/middleware.js'];
const INSTRUMENTATION_FILES = ['instrumentation.ts', 'instrumentation.js', 'src/instrumentation.ts', 'src/instrumentation.js'];
const WORKER_FILES = ['hypdriv.worker.ts', 'hypdriv.worker.mts', 'hypdriv.worker.js', 'hypdriv.worker.mjs'];
const OPEN_NEXT_CONFIG_FILES = ['open-next.config.ts', 'open-next.config.mts', 'open-next.config.js', 'open-next.config.mjs'];
const LAYOUT_FILES = ['app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js'];
export const TOKENS_FILE_CANDIDATES = ['lib/tokens.ts', 'lib/tokens.js', 'src/lib/tokens.ts', 'app/tokens.ts', 'tokens.ts'];

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
    importsWithHypDriv: /\bwithHypDriv\b/.test(source) && /(?:from\s+['"](?:@hypdriv\/next\/config|hypdriv\/config|hypdriv|@hypdriv\/next)['"]|require\(['"](?:@hypdriv\/next\/config|hypdriv\/config|hypdriv)['"]\))/.test(source),
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
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      keys.push(key);
      lengths[key] = value.length;
    }
  }
  const gitignore = readText(join(root, '.gitignore')) ?? readText(join(findRepoRoot(root), '.gitignore')) ?? '';
  const gitignored = gitignore.split(/\r?\n/).some((l) => /^\s*\.dev\.vars(\*|\.\*)?\s*$/.test(l) || /^\s*\.dev\.vars\*?\s*$/.test(l));
  return { file, exampleFile, keys, lengths, gitignored };
}

function readWrangler(root: string, pkg: PackageInfo | null): WranglerInfo {
  const base = versionInfo(root, pkg, 'wrangler');
  const candidates: Array<[string, WranglerFormat]> = [
    ['wrangler.jsonc', 'jsonc'],
    ['wrangler.json', 'json'],
    ['wrangler.toml', 'toml'],
  ];
  for (const [name, format] of candidates) {
    const file = join(root, name);
    if (!exists(file)) continue;
    try {
      return { ...base, configFile: file, format, config: parseWranglerConfig(readFileSync(file, 'utf8'), format), parseError: null };
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

export interface DetectOptions {
  /** Skip the source scan (faster for commands that do not need it). */
  scan?: boolean;
  nodeVersion?: string;
}

/** Detects everything the commands and doctor checks need to know about a project. Pure reads; never writes. */
export function detectProject(start: string, options: DetectOptions = {}): ProjectInfo {
  const root = findProjectRoot(resolve(start));
  const repoRoot = findRepoRoot(root);
  const pkg = readPackageJson(root);
  const srcDir = isDirectory(join(root, 'src')) && !isDirectory(join(root, 'app')) && !isDirectory(join(root, 'pages'));
  const appDir = isDirectory(join(root, 'app')) || isDirectory(join(root, 'src', 'app'));
  const pagesDir = isDirectory(join(root, 'pages')) || isDirectory(join(root, 'src', 'pages'));
  const typescript = versionInfo(root, pkg, 'typescript');
  const buildIdFile = join(root, '.next', 'BUILD_ID');
  const hypdrivPackages: Record<string, string> = {};
  for (const name of ['hypdriv', '@hypdriv/core', '@hypdriv/next', '@hypdriv/cloudflare', '@hypdriv/cli', '@hypdriv/security', '@hypdriv/purser']) {
    const v = installedVersion(root, name);
    if (v) hypdrivPackages[name] = v;
  }
  const nextConfigFile = firstExisting(root, NEXT_CONFIG_FILES);
  const purserVersion = installedVersion(root, '@avonao/purser');
  return {
    root,
    repoRoot,
    inHypDrivMonorepo: detectHypDrivMonorepo(repoRoot),
    workspace: exists(join(repoRoot, 'pnpm-workspace.yaml')),
    packageManager: detectPackageManager(root),
    packageJson: pkg,
    name: pkg?.name ?? basename(root),
    srcDir,
    router: { app: appDir, pages: pagesDir },
    node: options.nodeVersion ?? process.versions.node,
    typescript: { ...typescript, major: parseVersion(typescript.installed)?.major ?? null },
    next: versionInfo(root, pkg, 'next'),
    react: versionInfo(root, pkg, 'react'),
    opennext: versionInfo(root, pkg, '@opennextjs/cloudflare'),
    wrangler: readWrangler(root, pkg),
    cloudflareConfigFile: firstExisting(root, ['cloudflare.config.ts', 'cloudflare.config.js', 'cloudflare.config.mjs']),
    nextConfig: nextConfigFile ? analyzeNextConfig(nextConfigFile, readText(nextConfigFile) ?? '') : null,
    proxyFile: firstExisting(root, PROXY_FILES),
    middlewareFile: firstExisting(root, MIDDLEWARE_FILES),
    instrumentationFile: firstExisting(root, INSTRUMENTATION_FILES),
    hypdrivConfigFile: findConfigFile(root),
    hypdrivWorkerFile: firstExisting(root, WORKER_FILES),
    openNextConfigFile: firstExisting(root, OPEN_NEXT_CONFIG_FILES),
    openNextWorkerFile: exists(join(root, '.open-next', 'worker.js')) ? join(root, '.open-next', 'worker.js') : null,
    nextBuild: isDirectory(join(root, '.next')) ? { dir: join(root, '.next'), buildId: readText(buildIdFile)?.trim() ?? null } : null,
    manifest: readManifestInfo(root),
    headersFile: exists(join(root, 'public', '_headers')) ? join(root, 'public', '_headers') : null,
    devVars: readDevVars(root),
    purser: {
      installed: purserVersion,
      tokensFile: TOKENS_FILE_CANDIDATES.find((c) => exists(join(root, c))) ?? null,
      strikeScript: purserVersion !== null && exists(join(findPackageDir(root, '@avonao/purser') ?? '', 'scripts', 'strike-count.js')),
    },
    hypdriv: {
      installed: hypdrivPackages.hypdriv ?? hypdrivPackages['@hypdriv/next'] ?? hypdrivPackages['@hypdriv/core'] ?? null,
      range: declaredRange(pkg, 'hypdriv') ?? declaredRange(pkg, '@hypdriv/next') ?? null,
      packages: hypdrivPackages,
    },
    layoutFile: firstExisting(root, LAYOUT_FILES),
    sources: options.scan === false ? { filesScanned: 0, truncated: false, edgeRuntime: [], nodeApis: [] } : scanSources(root),
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
export function execCommand(pm: PackageManager, bin: string, args: string[]): { command: string; args: string[] } {
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

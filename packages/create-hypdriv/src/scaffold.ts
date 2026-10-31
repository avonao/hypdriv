import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  type Framework,
  NAME,
  NAME_UNDERSCORED,
  type Platform,
  type TemplateId,
  templateFor,
} from './templates';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface ScaffoldOptions {
  /** Directory to create (relative to `cwd`). */
  directory: string;
  platform: Platform;
  purser: boolean;
  /** Next.js (default) or a Vite host. */
  framework?: Framework;
  packageManager: PackageManager;
  /** Directory holding the synced templates (`<package>/templates`). */
  templatesDir: string;
  cwd?: string;
  /** Overrides the package name (default: the directory name, normalised). */
  name?: string;
  /** Clock for the Workers compatibility date (tests). */
  now?: Date;
  /** Secret generator (tests). */
  secret?: () => string;
}

export interface ScaffoldResult {
  root: string;
  name: string;
  template: TemplateId;
  files: string[];
  /** Local secrets file written with generated values (`.dev.vars` or `.env.local`). */
  secretsFile: string;
}

/** npm package-name rules (lowercase, URL-safe, ≤ 214 characters, no leading `.`/`_`). */
export function validateName(name: string): string | null {
  if (!name) return 'the project name is empty';
  if (name.length > 214) return 'the project name is longer than 214 characters';
  if (name !== name.toLowerCase()) return 'the project name must be lowercase';
  if (/^[._]/.test(name)) return 'the project name cannot start with "." or "_"';
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name))
    return 'the project name may only contain lowercase letters, digits, "-", "." and "_"';
  return null;
}

/** A package name derived from a directory name (`My App` → `my-app`). */
export function toPackageName(directory: string): string {
  return (
    basename(resolve(directory))
      .toLowerCase()
      .replace(/[^a-z0-9-._~]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '') || 'hypdriv-app'
  );
}

/** The package manager that launched the scaffolder (`npm create`, `pnpm create`, `yarn create`, `bun create`). */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const ua = userAgent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}

/** Workers name rules: 1–63 characters, lowercase letters, digits and `-`, no leading/trailing `-`. */
export function workerName(name: string): string {
  const base = name
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (base || 'hypdriv-app').slice(0, 63).replace(/-+$/, '');
}

/** First day of the current month (UTC): a valid, recent Workers compatibility date. */
export function compatibilityDate(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function defaultSecret(): string {
  return randomBytes(32).toString('base64url');
}

function listFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, root));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

/** `true` when the directory is missing, empty, or only holds VCS/editor metadata. */
export function isUsableDirectory(dir: string): boolean {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  const ignorable = new Set(['.git', '.DS_Store', '.idea', '.vscode', 'Thumbs.db', 'LICENSE', 'README.md']);
  return readdirSync(dir).every((name) => ignorable.has(name));
}

/** Fills a `.dev.vars.example` / `.env.example` with generated secrets for local development. */
export function fillSecrets(
  example: string,
  secret: () => string,
  extra: Record<string, string> = {},
): string {
  return `${example
    .split(/\r?\n/)
    .map((line) => {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m) return line;
      const [, key, value] = m as unknown as [string, string, string];
      if (key in extra) return `${key}=${extra[key]}`;
      if (/(_SECRET|_TOKEN_SECRET)$/.test(key) && (value === '' || /change-me/i.test(value)))
        return `${key}=${secret()}`;
      return line;
    })
    .join('\n')
    .replace(/\n*$/, '\n')}`;
}

function pnpmWorkspaceYaml(platform: Platform): string {
  const builds = platform === 'cloudflare' ? ['esbuild', 'sharp', 'workerd'] : ['esbuild', 'sharp'];
  return [
    '# Dependencies allowed to run install scripts (pnpm ≥ 10).',
    'onlyBuiltDependencies:',
    ...builds.map((name) => `  - ${name}`),
    'allowBuilds:',
    ...builds.map((name) => `  ${name}: true`),
    '',
  ].join('\n');
}

/** Copies the template into the target directory and personalises it. Never overwrites user files. */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const cwd = options.cwd ?? process.cwd();
  const root = resolve(cwd, options.directory);
  const name = options.name ?? toPackageName(root);
  const invalid = validateName(name);
  if (invalid) throw new Error(`${invalid} ("${name}")`);
  if (!isUsableDirectory(root)) throw new Error(`${root} is not empty; choose a new directory`);
  const template = templateFor(options.platform, options.purser, options.framework ?? 'next');
  const source = join(options.templatesDir, template);
  if (!existsSync(source)) throw new Error(`template ${template} is missing from ${options.templatesDir}`);
  const secret = options.secret ?? defaultSecret;
  const worker = workerName(name);
  const now = options.now ?? new Date();

  const written: string[] = [];
  for (const rel of listFiles(source)) {
    const target = rel === '_gitignore' ? '.gitignore' : rel;
    const to = join(root, target);
    if (existsSync(to)) continue;
    let content = readFileSync(join(source, rel), 'utf8');
    content = content.split(NAME_UNDERSCORED).join(worker.replace(/-/g, '_'));
    // Worker, service-binding and bucket names follow the Workers naming rules, not npm's.
    if (target === 'wrangler.jsonc' || target.endsWith('/wrangler.jsonc'))
      content = content
        .split(NAME)
        .join(worker)
        .replace(
          /"compatibility_date": "\d{4}-\d{2}-\d{2}"/,
          `"compatibility_date": "${compatibilityDate(now)}"`,
        );
    else content = content.split(NAME).join(name);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
    written.push(target);
  }

  if (options.packageManager === 'pnpm' && !existsSync(join(root, 'pnpm-workspace.yaml'))) {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml(options.platform));
    written.push('pnpm-workspace.yaml');
  }

  // Local secrets with real random values (both files are git-ignored).
  const secretsFile = options.platform === 'cloudflare' ? '.dev.vars' : '.env.local';
  const exampleFile = options.platform === 'cloudflare' ? '.dev.vars.example' : '.env.example';
  const secretsPath = join(root, secretsFile);
  if (!existsSync(secretsPath) && existsSync(join(root, exampleFile))) {
    writeFileSync(secretsPath, fillSecrets(readFileSync(join(root, exampleFile), 'utf8'), secret));
    written.push(secretsFile);
  }
  return { root, name, template, files: written.sort(), secretsFile };
}

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  detectPackageManager,
  isUsableDirectory,
  type PackageManager,
  type ScaffoldResult,
  scaffold,
  toPackageName,
  validateName,
} from './scaffold';
import type { Platform } from './templates';

declare const __HYPDRIV_VERSION__: string;
const VERSION = typeof __HYPDRIV_VERSION__ === 'string' ? __HYPDRIV_VERSION__ : '0.0.0';

export interface CliIO {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  /** Interactive prompts are offered only on a TTY. */
  interactive: boolean;
  ask?: (question: string) => Promise<string>;
  /** Runs a command in `cwd`; returns the exit code. */
  run?: (command: string, args: string[], cwd: string) => number;
  templatesDir?: string;
}

const HELP = `create-hypdriv ${VERSION}

Scaffold a Next.js 16 app with HypDriv on Cloudflare Workers (OpenNext) or Vercel.

Usage
  npm create hypdriv@latest [directory] -- [options]
  pnpm create hypdriv [directory] [options]

Options
  --platform <cloudflare|vercel>  Deploy target (default: cloudflare)
  --purser                        Style the app with Purser CSS (zero-override atomic CSS, flashless themes)
  --pm <pnpm|npm|yarn|bun>        Package manager (default: the one running create-hypdriv)
  --name <package-name>           package.json name (default: from the directory)
  --no-install                    Skip installing dependencies
  --no-git                        Skip git init and the initial commit
  -y, --yes                       Accept defaults without prompting
  --json                          Print the result as JSON
  -v, --version                   Print the version
  -h, --help                      Show this help
`;

function defaultTemplatesDir(): string {
  // dist/index.js → ../templates (published layout); src/cli.ts → ../templates after `pnpm build`.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

function defaultRun(command: string, args: string[], cwd: string): number {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status ?? 1;
}

function installArgs(pm: PackageManager): string[] {
  return pm === 'yarn' ? [] : ['install'];
}

function runScript(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

async function askChoice<T extends string>(
  ask: (q: string) => Promise<string>,
  question: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  for (;;) {
    const answer = (await ask(`${question} (${choices.join('/')}) [${fallback}] `)).trim().toLowerCase();
    if (!answer) return fallback;
    const hit = choices.find((c) => c === answer || c.startsWith(answer));
    if (hit) return hit;
  }
}

async function askYesNo(
  ask: (q: string) => Promise<string>,
  question: string,
  fallback: boolean,
): Promise<boolean> {
  const answer = (await ask(`${question} (y/n) [${fallback ? 'y' : 'n'}] `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('y');
}

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      platform: { type: 'string' },
      purser: { type: 'boolean' },
      pm: { type: 'string' },
      name: { type: 'string' },
      'no-install': { type: 'boolean' },
      'no-git': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      json: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

/** Runs the scaffolder; returns the process exit code. */
export async function main(io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(io.argv);
  } catch (err) {
    io.stderr.write(`create-hypdriv: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const json = values.json === true;
  const prompt = io.interactive && !values.yes && !json && io.ask !== undefined;
  const ask = io.ask ?? (async () => '');
  const log = (text: string) => {
    if (!json) io.stdout.write(`${text}\n`);
  };

  let directory = positionals[0];
  if (!directory && prompt)
    directory = (await ask('Project directory: [hypdriv-app] ')).trim() || 'hypdriv-app';
  directory ??= 'hypdriv-app';

  const platformArg = values.platform?.toLowerCase();
  if (platformArg && platformArg !== 'cloudflare' && platformArg !== 'vercel') {
    io.stderr.write(`create-hypdriv: --platform must be cloudflare or vercel (got "${values.platform}")\n`);
    return 2;
  }
  const platform: Platform =
    (platformArg as Platform | undefined) ??
    (prompt
      ? await askChoice(ask, 'Deploy to', ['cloudflare', 'vercel'] as const, 'cloudflare')
      : 'cloudflare');
  const purser = values.purser ?? (prompt ? await askYesNo(ask, 'Use Purser CSS?', false) : false);

  const pmArg = values.pm?.toLowerCase();
  if (pmArg && !['pnpm', 'npm', 'yarn', 'bun'].includes(pmArg)) {
    io.stderr.write(`create-hypdriv: --pm must be pnpm, npm, yarn or bun (got "${values.pm}")\n`);
    return 2;
  }
  const packageManager =
    (pmArg as PackageManager | undefined) ?? detectPackageManager(io.env.npm_config_user_agent);

  const name = values.name ?? toPackageName(join(io.cwd, directory));
  const invalid = validateName(name);
  if (invalid) {
    io.stderr.write(`create-hypdriv: ${invalid} ("${name}"); pass --name <package-name>\n`);
    return 2;
  }
  const target = join(io.cwd, directory);
  if (!isUsableDirectory(target)) {
    io.stderr.write(`create-hypdriv: ${target} already exists and is not empty\n`);
    return 1;
  }

  let result: ScaffoldResult;
  try {
    result = scaffold({
      directory,
      cwd: io.cwd,
      name,
      platform,
      purser,
      packageManager,
      templatesDir: io.templatesDir ?? defaultTemplatesDir(),
    });
  } catch (err) {
    io.stderr.write(`create-hypdriv: ${(err as Error).message}\n`);
    return 1;
  }
  log(`\nCreated ${name} (${result.template}) in ${relative(io.cwd, result.root) || '.'}`);
  log(`  ${result.files.length} files · local secrets generated in ${result.secretsFile}`);

  const run = io.run ?? defaultRun;
  let installed = false;
  if (!values['no-install']) {
    log(`\nInstalling dependencies with ${packageManager}…`);
    const code = run(packageManager, installArgs(packageManager), result.root);
    installed = code === 0;
    if (!installed)
      io.stderr.write(`create-hypdriv: ${packageManager} install failed (exit ${code}); run it yourself.\n`);
  }

  let git: 'committed' | 'initialized' | 'skipped' | 'failed' = 'skipped';
  if (!values['no-git'] && !existsSync(join(result.root, '.git'))) {
    if (run('git', ['init', '-q'], result.root) !== 0) git = 'failed';
    else {
      git = 'initialized';
      if (
        run('git', ['add', '-A'], result.root) === 0 &&
        run('git', ['commit', '-q', '-m', 'Initial commit from create-hypdriv'], result.root) === 0
      )
        git = 'committed';
    }
  }

  const steps = [
    relative(io.cwd, result.root) ? `cd ${relative(io.cwd, result.root)}` : null,
    installed ? null : `${packageManager} install`,
    runScript(packageManager, 'dev'),
    platform === 'cloudflare'
      ? `${runScript(packageManager, 'preview')}   # OpenNext build + wrangler dev (the Worker)`
      : `${runScript(packageManager, 'build')}     # next build (withHypDriv emits Vercel CDN headers)`,
    `${runScript(packageManager, 'hypdriv:doctor')}`,
    platform === 'cloudflare'
      ? `${runScript(packageManager, 'deploy')}`
      : 'vercel deploy   # or connect the repository in the Vercel dashboard (region iad1)',
  ].filter((s): s is string => s !== null);

  if (json)
    io.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          root: result.root,
          name: result.name,
          template: result.template,
          platform,
          purser,
          packageManager,
          files: result.files,
          secretsFile: result.secretsFile,
          installed,
          git,
          next: steps,
        },
        null,
        2,
      )}\n`,
    );
  else {
    if (git === 'failed') log('git init failed; initialise the repository yourself.');
    else if (git === 'initialized')
      log('git repository initialised (no commit: configure user.name/user.email).');
    log('\nNext steps:');
    for (const step of steps) log(`  ${step}`);
    if (purser)
      log('\nPurser CSS: install @avonao/purser if it was not installed with the optional dependencies.');
    log('');
  }
  return 0;
}

/** Process entry (`bin`). */
export async function run(): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let rl: ReturnType<typeof createInterface> | null = null;
  try {
    return await main({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      interactive,
      ask: async (question) => {
        rl ??= createInterface({ input: process.stdin, output: process.stdout });
        return rl.question(question);
      },
    });
  } finally {
    (rl as ReturnType<typeof createInterface> | null)?.close();
  }
}

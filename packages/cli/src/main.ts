import { parseCommandArgs, renderCommandHelp, renderGlobalHelp, UsageError } from './args';
import { commands, findCommand } from './commands/index';
import { CliError } from './context';
import { createNodeIO, type IO } from './io';
import { colorEnabled, createPalette } from './ui';
import { cliVersion } from './version';

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length]![b.length]!;
}

function suggest(name: string): string | null {
  let best: { name: string; d: number } | null = null;
  for (const c of commands) {
    const d = levenshtein(name, c.name);
    if (!best || d < best.d) best = { name: c.name, d };
  }
  return best && best.d <= 2 ? best.name : null;
}

function reportError(io: IO, json: boolean, err: unknown, exitCode: number): number {
  const e = err as Error;
  if (json) {
    io.stdout.write(
      `${JSON.stringify({ ok: false, error: { type: e.name ?? 'Error', message: e.message } }, null, 2)}\n`,
    );
    return exitCode;
  }
  const color = createPalette(colorEnabled(io.env, io.isTTY));
  io.stderr.write(`${color.red('error')} ${e.message}\n`);
  if (exitCode === 2) io.stderr.write(color.dim('Run `hypdriv <command> --help` for usage.\n'));
  if (!(err instanceof CliError) && !(err instanceof UsageError) && io.env.HYPDRIV_DEBUG && e.stack)
    io.stderr.write(`${e.stack}\n`);
  return exitCode;
}

/**
 * Runs one command programmatically with an injectable IO. Returns the exit code (0 ok, 1 findings or
 * failures, 2 usage error) and never calls `process.exit`.
 */
export async function runCommand(name: string, argv: string[] = [], io: Partial<IO> = {}): Promise<number> {
  const fullIo = createNodeIO(io);
  const command = findCommand(name);
  const json = argv.includes('--json');
  if (!command) {
    const hint = suggest(name);
    return reportError(
      fullIo,
      json,
      new UsageError(`unknown command "${name}"${hint ? ` — did you mean "${hint}"?` : ''}`),
      2,
    );
  }
  let args: ReturnType<typeof parseCommandArgs>;
  try {
    args = parseCommandArgs(argv, command.options);
  } catch (err) {
    return reportError(fullIo, json, err, 2);
  }
  if (args.help) {
    fullIo.stdout.write(renderCommandHelp(command));
    return 0;
  }
  try {
    return await command.run(args, fullIo);
  } catch (err) {
    if (err instanceof UsageError) return reportError(fullIo, args.json, err, 2);
    if (err instanceof CliError) return reportError(fullIo, args.json, err, err.exitCode);
    return reportError(fullIo, args.json, err, 1);
  }
}

/**
 * The `hypdriv` entry point: `main(process.argv.slice(2))`. Resolves to the exit code; the caller sets
 * `process.exitCode`.
 */
export async function main(argv: string[], io: Partial<IO> = {}): Promise<number> {
  const [first, ...rest] = argv;
  const fullIo = createNodeIO(io);
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const target = first === 'help' ? rest[0] : undefined;
    const command = target ? findCommand(target) : undefined;
    if (target && !command)
      return reportError(fullIo, false, new UsageError(`unknown command "${target}"`), 2);
    fullIo.stdout.write(command ? renderCommandHelp(command) : renderGlobalHelp(commands, cliVersion()));
    return 0;
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    fullIo.stdout.write(
      argv.includes('--json') ? `${JSON.stringify({ version: cliVersion() })}\n` : `${cliVersion()}\n`,
    );
    return 0;
  }
  if (first.startsWith('-')) {
    // Global flags before the command (`hypdriv --root apps/web doctor`): move them after it.
    const index = argv.findIndex(
      (a, i) =>
        !a.startsWith('-') && !(i > 0 && ['--root', '--platform', '--wrangler'].includes(argv[i - 1]!)),
    );
    if (index === -1)
      return reportError(fullIo, argv.includes('--json'), new UsageError('missing command'), 2);
    const name = argv[index]!;
    return runCommand(name, [...argv.slice(index + 1), ...argv.slice(0, index)], io);
  }
  return runCommand(first, rest, io);
}

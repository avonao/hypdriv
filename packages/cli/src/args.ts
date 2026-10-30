import { parseArgs } from 'node:util';

/** Declarative description of one command-line option. */
export interface OptionDefinition {
  type: 'string' | 'boolean';
  short?: string;
  description: string;
  default?: string | boolean;
  /** Accept the option several times (`--paths a --paths b`). */
  multiple?: boolean;
  /** Placeholder shown in help for string options (`<dir>`). */
  value?: string;
}

export type OptionSpec = Record<string, OptionDefinition>;

/** Options every command accepts. */
export const GLOBAL_OPTIONS: OptionSpec = {
  json: {
    type: 'boolean',
    description: 'Machine-readable output: one JSON document on stdout, nothing else',
  },
  root: { type: 'string', value: '<dir>', description: 'Project directory (default: nearest package.json)' },
  platform: {
    type: 'string',
    value: '<name>',
    description: 'Deployment target: cloudflare | vercel | node (default: detected)',
  },
  help: { type: 'boolean', short: 'h', description: 'Show help for the command' },
  'no-color': { type: 'boolean', description: 'Disable colours (NO_COLOR=1 does the same)' },
};

export type OptionValue = string | boolean | string[] | undefined;

/** Thrown for invalid invocations; the binary maps it to exit code 2. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Parsed command line with typed accessors. */
export interface ParsedArgs {
  /** Raw arguments after the command name. */
  readonly argv: string[];
  readonly positionals: string[];
  readonly values: Record<string, OptionValue>;
  readonly json: boolean;
  readonly root: string | undefined;
  readonly help: boolean;
  /** `false` when `--no-color` was passed, otherwise `undefined` (auto). */
  readonly color: boolean | undefined;
  string(name: string): string | undefined;
  boolean(name: string): boolean;
  /** Numeric option with validation; falls back when absent. */
  number(name: string, fallback: number, options?: { min?: number; max?: number; integer?: boolean }): number;
  /** Repeated and comma-separated string option as a list. */
  list(name: string): string[];
}

function toParseArgsOptions(spec: OptionSpec) {
  const out: Record<
    string,
    { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: string | boolean | string[] }
  > = {};
  for (const [name, def] of Object.entries(spec)) {
    const entry: (typeof out)[string] = { type: def.type };
    if (def.short) entry.short = def.short;
    if (def.multiple) entry.multiple = true;
    if (def.default !== undefined && !def.multiple) entry.default = def.default;
    out[name] = entry;
  }
  return out;
}

/**
 * Parses `argv` (without the command name) against the command's options plus the global ones.
 * Unknown options and missing values are usage errors.
 */
export function parseCommandArgs(argv: string[], spec: OptionSpec): ParsedArgs {
  const merged: OptionSpec = { ...GLOBAL_OPTIONS, ...spec };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: toParseArgsOptions(merged),
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const message = (err as Error).message.replace(/^.*?: /, '');
    throw new UsageError(message);
  }
  const values = parsed.values as Record<string, OptionValue>;
  const str = (name: string): string | undefined => {
    const v = values[name];
    if (Array.isArray(v)) return v[v.length - 1];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    argv,
    positionals: parsed.positionals,
    values,
    json: values.json === true,
    root: str('root'),
    help: values.help === true,
    color: values['no-color'] === true ? false : undefined,
    string: str,
    boolean: (name) => values[name] === true,
    number(name, fallback, opts = {}) {
      const raw = str(name);
      if (raw === undefined || raw === '') return fallback;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${raw}"`);
      if (opts.integer !== false && !Number.isInteger(n))
        throw new UsageError(`--${name} expects an integer`);
      if (opts.min !== undefined && n < opts.min)
        throw new UsageError(`--${name} must be at least ${opts.min}`);
      if (opts.max !== undefined && n > opts.max)
        throw new UsageError(`--${name} must be at most ${opts.max}`);
      return n;
    },
    list(name) {
      const v = values[name];
      const items = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
      return items
        .flatMap((item) => item.split(','))
        .map((s) => s.trim())
        .filter(Boolean);
    },
  };
}

/** Static description of a command used for dispatch and help. */
export interface CommandInfo {
  name: string;
  summary: string;
  usage: string;
  options: OptionSpec;
  /** Sub-command names (for `csp hashes|suggest|print`, `css build|check|watch`, ...). */
  subcommands?: Array<{ name: string; summary: string }>;
  examples?: string[];
  /** Longer description shown in `--help`. */
  details?: string;
}

function optionLines(spec: OptionSpec): string[] {
  const rows = Object.entries(spec).map(([name, def]) => {
    const flag = `${def.short ? `-${def.short}, ` : '    '}--${name}${def.type === 'string' ? ` ${def.value ?? '<value>'}` : ''}`;
    const extra =
      def.default !== undefined && def.default !== false ? ` (default: ${String(def.default)})` : '';
    return [flag, `${def.description}${extra}`] as const;
  });
  const width = Math.max(0, ...rows.map(([flag]) => flag.length));
  return rows.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`);
}

/** Help text for one command. */
export function renderCommandHelp(info: CommandInfo): string {
  const lines: string[] = [];
  lines.push(`${info.summary}`);
  lines.push('');
  lines.push(`Usage: ${info.usage}`);
  if (info.details) {
    lines.push('');
    lines.push(info.details);
  }
  if (info.subcommands?.length) {
    lines.push('');
    lines.push('Subcommands:');
    const width = Math.max(...info.subcommands.map((s) => s.name.length));
    for (const s of info.subcommands) lines.push(`  ${s.name.padEnd(width)}  ${s.summary}`);
  }
  if (Object.keys(info.options).length) {
    lines.push('');
    lines.push('Options:');
    lines.push(...optionLines(info.options));
  }
  lines.push('');
  lines.push('Global options:');
  lines.push(...optionLines(GLOBAL_OPTIONS));
  if (info.examples?.length) {
    lines.push('');
    lines.push('Examples:');
    for (const e of info.examples) lines.push(`  ${e}`);
  }
  lines.push('');
  lines.push('Exit codes: 0 ok · 1 findings or failures · 2 usage error');
  return `${lines.join('\n')}\n`;
}

/** Top-level help listing every command. */
export function renderGlobalHelp(commands: CommandInfo[], version: string): string {
  const lines: string[] = [];
  lines.push(`hypdriv ${version} — the HypDriv command for Next.js 16+ on Cloudflare Workers`);
  lines.push('');
  lines.push('Usage: hypdriv <command> [options]');
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...commands.map((c) => c.name.length));
  for (const c of commands) lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  lines.push('');
  lines.push('Global options:');
  lines.push(...optionLines(GLOBAL_OPTIONS));
  lines.push('      --version        Print the CLI version');
  lines.push('');
  lines.push('Run `hypdriv <command> --help` for the options of a command.');
  lines.push('Docs: https://github.com/avonao/hypdriv/blob/main/docs/guides/cli.md');
  return `${lines.join('\n')}\n`;
}

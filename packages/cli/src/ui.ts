import type { IO } from './io';

/** Style functions; identity functions when colours are off. */
export interface Palette {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
  gray(text: string): string;
  underline(text: string): string;
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Removes ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Visible width of a string (ANSI stripped; wide/combining characters approximated). */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x200b || (code >= 0x0300 && code <= 0x036f) || code === 0xfe0f) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Decides whether to emit colours: `NO_COLOR` wins, then `FORCE_COLOR`, then TTY detection. */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '') return true;
  if (env.TERM === 'dumb') return false;
  return isTTY;
}

export function createPalette(enabled: boolean): Palette {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
    gray: wrap(90, 39),
    underline: wrap(4, 24),
  };
}

export type Status = 'pass' | 'warn' | 'fail' | 'skip' | 'info';

export interface TableColumn {
  header: string;
  align?: 'left' | 'right';
  /** Maximum width; longer cells are truncated with an ellipsis. */
  maxWidth?: number;
}

export interface TableOptions {
  columns: Array<TableColumn | string>;
  /** Indentation for every line. */
  indent?: string;
  /** Print a header rule (default true). */
  rule?: boolean;
}

function truncate(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  const plain = stripAnsi(text);
  if (max <= 1) return plain.slice(0, max);
  return `${plain.slice(0, max - 1)}…`;
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
}

/** Renders an aligned text table. Cells may contain ANSI colours; widths ignore them. */
export function renderTable(rows: Array<Array<string | number>>, options: TableOptions): string {
  const columns = options.columns.map((c) => (typeof c === 'string' ? { header: c } : c));
  const cells = rows.map((row) =>
    columns.map((col, i) => {
      const raw = row[i];
      const text = raw === undefined || raw === null ? '' : String(raw);
      return col.maxWidth ? truncate(text, col.maxWidth) : text;
    }),
  );
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...cells.map((row) => visibleWidth(row[i] ?? ''))),
  );
  const indent = options.indent ?? '';
  const line = (items: string[]) =>
    indent +
    items
      .map((item, i) => pad(item, widths[i]!, columns[i]?.align ?? 'left'))
      .join('  ')
      .trimEnd();
  const lines = [line(columns.map((c) => c.header))];
  if (options.rule !== false) lines.push(line(widths.map((w) => '─'.repeat(w))));
  for (const row of cells) lines.push(line(row));
  return `${lines.join('\n')}\n`;
}

export interface UiOptions {
  json: boolean;
  color?: boolean;
}

/** Output helpers bound to an IO. In JSON mode every human-facing method is a no-op. */
export interface Ui {
  readonly json: boolean;
  readonly color: Palette;
  write(text: string): void;
  line(text?: string): void;
  heading(text: string): void;
  subheading(text: string): void;
  kv(pairs: Array<[string, string | number | boolean | null | undefined]>, indent?: string): void;
  table(rows: Array<Array<string | number>>, options: TableOptions): void;
  status(status: Status, text: string, detail?: string): void;
  statusIcon(status: Status): string;
  warn(text: string): void;
  error(text: string): void;
  note(text: string): void;
  list(items: string[], indent?: string): void;
  /** Prints a JSON document to stdout (used by `--json` regardless of mode). */
  printJson(value: unknown): void;
}

export function createUi(io: IO, options: UiOptions): Ui {
  const color = createPalette(options.color ?? colorEnabled(io.env, io.isTTY));
  const quiet = options.json;
  const write = (text: string) => {
    if (!quiet) io.stdout.write(text);
  };
  const icons: Record<Status, string> = {
    pass: color.green('✓'),
    warn: color.yellow('!'),
    fail: color.red('✗'),
    skip: color.gray('-'),
    info: color.cyan('i'),
  };
  return {
    json: options.json,
    color,
    write,
    line: (text = '') => write(`${text}\n`),
    heading: (text) => write(`\n${color.bold(text)}\n`),
    subheading: (text) => write(`${color.bold(text)}\n`),
    kv(pairs, indent = '  ') {
      const width = Math.max(0, ...pairs.map(([k]) => visibleWidth(k)));
      for (const [k, v] of pairs) {
        const value = v === undefined || v === null ? color.dim('—') : String(v);
        write(`${indent}${pad(color.dim(k), width, 'left')}  ${value}\n`);
      }
    },
    table: (rows, tableOptions) => write(renderTable(rows, tableOptions)),
    status(status, text, detail) {
      write(`${icons[status]} ${text}${detail ? color.dim(`  ${detail}`) : ''}\n`);
    },
    statusIcon: (status) => icons[status],
    warn: (text) => write(`${color.yellow('warning')} ${text}\n`),
    error(text) {
      if (!quiet) io.stderr.write(`${color.red('error')} ${text}\n`);
    },
    note: (text) => write(`${color.dim(text)}\n`),
    list(items, indent = '  ') {
      for (const item of items) write(`${indent}• ${item}\n`);
    },
    printJson(value) {
      io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/** `12.3 kB` style formatting with a stable width for tables. */
export function bytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

/** Signed delta formatting (`+1.2 kB`, `-300 B`, `±0`). */
export function delta(n: number): string {
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '-'}${bytes(Math.abs(n))}`;
}

/** Milliseconds for humans. */
export function millis(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Percentage with one decimal. */
export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** Pluralises a noun. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

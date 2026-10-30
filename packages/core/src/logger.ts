export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;

/** Minimal logger contract shared by every package; `@hypdriv/observe` provides rich implementations. */
export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a child logger with bound fields. */
  child(fields: LogFields): Logger;
}

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  fields?: LogFields;
  sink?: (line: string, level: Exclude<LogLevel, 'silent'>) => void;
  clock?: () => string;
}

const SECRET_KEYS =
  /(password|passwd|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|session|credential)/i;

/**
 * Correlation identifiers are long opaque strings by design (UUIDv7 request ids, 32-hex trace ids) and
 * must survive redaction, or logs can no longer be joined with traces. Values under these keys skip the
 * opaque-string heuristic (secret-looking key names are still redacted).
 */
export const ID_FIELD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'requestid',
  'request_id',
  'traceid',
  'trace_id',
  'spanid',
  'span_id',
  'parentspanid',
  'parent_span_id',
  'correlationid',
  'buildid',
  'deploymentid',
  'routeid',
  'jobid',
  'messageid',
  'visitorid',
]);

/**
 * Redacts values whose key looks secret and long opaque strings that look like credentials. Values under
 * correlation-id keys ({@link ID_FIELD_KEYS} plus `allowKeys`) are kept.
 */
export function redactFields(fields: LogFields, extraKeys: string[] = [], allowKeys: string[] = []): LogFields {
  const extra = new Set(extraKeys.map((k) => k.toLowerCase()));
  const allow = new Set(allowKeys.map((k) => k.toLowerCase()));
  const walk = (value: unknown, depth: number, key?: string): unknown => {
    if (depth > 6) return '[depth]';
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEYS.test(k) || extra.has(k.toLowerCase()) ? '[redacted]' : walk(v, depth + 1, k);
      }
      return out;
    }
    const lower = key?.toLowerCase();
    if (lower && (ID_FIELD_KEYS.has(lower) || allow.has(lower)) && typeof value === 'string') return value;
    if (
      typeof value === 'string' &&
      /^(?:Bearer\s+)?[A-Za-z0-9_-]{32,}$/.test(value) &&
      /\d/.test(value) &&
      /[A-Za-z]/.test(value)
    )
      return '[redacted]';
    return value;
  };
  return walk(fields, 0) as LogFields;
}

/** Structured console logger (JSON lines by default), safe in Workers and Node. */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const base = options.fields ?? {};
  const clock = options.clock ?? (() => new Date().toISOString());
  const sink =
    options.sink ??
    ((line: string, lvl: Exclude<LogLevel, 'silent'>) => {
      const fn =
        lvl === 'error'
          ? console.error
          : lvl === 'warn'
            ? console.warn
            : lvl === 'debug'
              ? console.debug
              : console.info;
      fn(line);
    });
  const threshold = LOG_LEVELS[level];

  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields) => {
    if (LOG_LEVELS[lvl] < threshold) return;
    const merged = redactFields({ ...base, ...(fields ?? {}) });
    if (format === 'json') {
      sink(JSON.stringify({ time: clock(), level: lvl, msg: message, ...merged }), lvl);
    } else {
      const extra = Object.keys(merged).length ? ` ${JSON.stringify(merged)}` : '';
      sink(`${clock()} ${lvl.toUpperCase().padEnd(5)} ${message}${extra}`, lvl);
    }
  };

  const make = (fields: LogFields): Logger => ({
    level,
    debug: (m, f) => emit('debug', m, { ...fields, ...f }),
    info: (m, f) => emit('info', m, { ...fields, ...f }),
    warn: (m, f) => emit('warn', m, { ...fields, ...f }),
    error: (m, f) => emit('error', m, { ...fields, ...f }),
    child: (more) => make({ ...fields, ...more }),
  });
  return make({});
}

export const silentLogger: Logger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

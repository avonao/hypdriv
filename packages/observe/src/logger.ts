import {
  bucketPercent,
  type ConsoleLoggerOptions,
  LOG_LEVELS,
  type LogFields,
  type Logger,
  type LogLevel,
  type ResolvedObserve,
  redactFields,
} from '@hypdriv/core';

export interface CreateLoggerOptions {
  /** Line sink (default: console, mapped by level like core's logger). */
  sink?: ConsoleLoggerOptions['sink'];
  clock?: () => string;
  /** Random source for sampling lines that carry no request id (tests). */
  random?: () => number;
}

/**
 * Correlation ids are long opaque strings and would trip core's credential heuristic; they are
 * never secrets, so they bypass value redaction (key-based redaction still applies to everything else).
 */
const ID_FIELDS = new Set(['requestId', 'traceId', 'spanId', 'parentSpanId']);

/** Redacts secret-looking keys and the configured extra keys from a field set (AGENTS.md: never log secrets). */
export function redact(fields: LogFields, extraKeys: string[] = []): LogFields {
  const ids: LogFields = {};
  const rest: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ID_FIELDS.has(k) && typeof v === 'string') ids[k] = v;
    else rest[k] = v;
  }
  return { ...redactFields(rest, extraKeys), ...ids };
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-hypdriv-signature',
]);

/** Converts headers into a loggable record with credentials replaced by `[redacted]`. */
export function redactHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
  extraNames: string[] = [],
): Record<string, string> {
  const extra = new Set(extraNames.map((n) => n.toLowerCase()));
  const out: Record<string, string> = {};
  const put = (name: string, value: string) => {
    const key = name.toLowerCase();
    out[key] = SENSITIVE_HEADERS.has(key) || extra.has(key) ? '[redacted]' : value;
  };
  if (headers instanceof Headers) headers.forEach((v, k) => put(k, v));
  else
    for (const [k, v] of Object.entries(headers))
      if (v !== undefined) put(k, Array.isArray(v) ? v.join(', ') : v);
  return out;
}

type EmitLevel = Exclude<LogLevel, 'silent'>;

function consoleSink(line: string, level: EmitLevel): void {
  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.info;
  fn(line);
}

/**
 * Structured logger for HypDriv: the same JSON / pretty line format as core's console logger, plus
 * the configured redaction keys, protected correlation ids and sampling of `debug`/`info` lines.
 * Sampling is decided once per request id (`requestId` field), so a request's lines are kept or
 * dropped together; `warn`/`error` are never sampled.
 */
export function createLogger(
  config: ResolvedObserve['logging'],
  fields: LogFields = {},
  options: CreateLoggerOptions = {},
): Logger {
  const level: LogLevel = config.level;
  const threshold = LOG_LEVELS[level];
  const format = config.format;
  const extra = config.redact;
  const sampleRate = Math.min(1, Math.max(0, config.sampleRate));
  const random = options.random ?? Math.random;
  const clock = options.clock ?? (() => new Date().toISOString());
  const sink = options.sink ?? consoleSink;

  const keep = (bound: LogFields): boolean => {
    if (sampleRate >= 1) return true;
    if (sampleRate <= 0) return false;
    const id = bound.requestId ?? bound.traceId;
    if (typeof id === 'string' && id) return bucketPercent(id, 'log') < sampleRate * 100;
    return random() < sampleRate;
  };

  const emit = (lvl: EmitLevel, bound: LogFields, message: string, f?: LogFields) => {
    if (LOG_LEVELS[lvl] < threshold) return;
    const merged = redact({ ...bound, ...(f ?? {}) }, extra);
    if (format === 'json') {
      sink(JSON.stringify({ time: clock(), level: lvl, msg: message, ...merged }), lvl);
    } else {
      const rest = Object.keys(merged).length ? ` ${JSON.stringify(merged)}` : '';
      sink(`${clock()} ${lvl.toUpperCase().padEnd(5)} ${message}${rest}`, lvl);
    }
  };

  const make = (bound: LogFields): Logger => ({
    level,
    debug(message, f) {
      if (keep(bound)) emit('debug', bound, message, f);
    },
    info(message, f) {
      if (keep(bound)) emit('info', bound, message, f);
    },
    warn(message, f) {
      emit('warn', bound, message, f);
    },
    error(message, f) {
      emit('error', bound, message, f);
    },
    child(more) {
      return make({ ...bound, ...more });
    },
  });
  return make(fields);
}

import {
  bucketPercent,
  type ConsoleLoggerOptions,
  createConsoleLogger,
  type LogFields,
  type Logger,
  type LogLevel,
  redactFields,
  type ResolvedObserve,
} from '@hypdriv/core';

export interface CreateLoggerOptions {
  /** Line sink (default: console). */
  sink?: ConsoleLoggerOptions['sink'];
  clock?: () => string;
  /** Random source for sampling lines that carry no request id (tests). */
  random?: () => number;
}

/** Redacts secret-looking keys and the configured extra keys from a field set (AGENTS.md: never log secrets). */
export function redact(fields: LogFields, extraKeys: string[] = []): LogFields {
  return redactFields(fields, extraKeys);
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
  else for (const [k, v] of Object.entries(headers)) if (v !== undefined) put(k, Array.isArray(v) ? v.join(', ') : v);
  return out;
}

/**
 * Structured logger for HypDriv: core's console logger plus the configured redaction keys and
 * sampling of `debug`/`info` lines. Sampling is decided once per request id (`requestId` field), so a
 * request's lines are kept or dropped together; `warn`/`error` are never sampled.
 */
export function createLogger(
  config: ResolvedObserve['logging'],
  fields: LogFields = {},
  options: CreateLoggerOptions = {},
): Logger {
  const base = createConsoleLogger({ level: config.level, format: config.format, sink: options.sink, clock: options.clock });
  const extra = config.redact;
  const sampleRate = Math.min(1, Math.max(0, config.sampleRate));
  const random = options.random ?? Math.random;
  const level: LogLevel = config.level;

  const keep = (bound: LogFields): boolean => {
    if (sampleRate >= 1) return true;
    if (sampleRate <= 0) return false;
    const id = bound.requestId ?? bound.traceId;
    if (typeof id === 'string' && id) return bucketPercent(id, 'log') < sampleRate * 100;
    return random() < sampleRate;
  };

  const make = (bound: LogFields): Logger => {
    const emit = (lvl: 'debug' | 'info' | 'warn' | 'error', message: string, f?: LogFields) =>
      base[lvl](message, redactFields({ ...bound, ...(f ?? {}) }, extra));
    return {
      level,
      debug(message, f) {
        if (keep(bound)) emit('debug', message, f);
      },
      info(message, f) {
        if (keep(bound)) emit('info', message, f);
      },
      warn(message, f) {
        emit('warn', message, f);
      },
      error(message, f) {
        emit('error', message, f);
      },
      child(more) {
        return make({ ...bound, ...more });
      },
    };
  };
  return make(fields);
}

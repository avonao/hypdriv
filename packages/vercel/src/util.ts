import { createConsoleLogger, HypDrivError, type Logger, readEnv, toError } from '@hypdriv/core';

/** First non-empty value among several environment variable names (`env` first, then `process.env`). */
export function readFirstEnv(env: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(env, name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Default logger for helpers created outside a request: warnings and errors only. */
export function defaultLogger(): Logger {
  return createConsoleLogger({ level: 'warn' });
}

const warned = new Set<string>();

/** Logs a warning once per process for `key` (misconfiguration notices must not flood request logs). */
export function warnOnce(log: Logger, key: string, message: string, fields?: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message, fields);
}

/** Test helper: forgets which one-time warnings were emitted. */
export function __resetWarnings(): void {
  warned.clear();
}

/**
 * `fetch` with a timeout. A timeout rejects with `HypDrivError('E_TIMEOUT')`, network failures with
 * `HypDrivError('E_UPSTREAM')`; the caller's own `signal` still aborts the request.
 */
export async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  service: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const outer = init.signal;
  const forward = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', forward, { once: true });
  }
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !outer?.aborted)
      throw new HypDrivError('E_TIMEOUT', `${service}: request timed out after ${timeoutMs} ms`, { service });
    throw new HypDrivError('E_UPSTREAM', `${service}: request failed: ${toError(error).message}`, { service }, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}

/** Parses `Retry-After` (delta seconds or an HTTP date) into milliseconds, or null when absent/invalid. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Promise-based delay (Web timers only). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Splits an array into chunks of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type RuntimeKind = 'workerd' | 'node' | 'bun' | 'deno' | 'browser' | 'unknown';

declare const navigator: { userAgent?: string } | undefined;
declare const process:
  | { versions?: Record<string, string>; env?: Record<string, string | undefined> }
  | undefined;
declare const Deno: unknown;
declare const Bun: unknown;
declare const window: unknown;
declare const EdgeRuntime: unknown;

let cached: RuntimeKind | null = null;

/** Detects the JavaScript runtime once. */
export function detectRuntime(): RuntimeKind {
  if (cached) return cached;
  let kind: RuntimeKind = 'unknown';
  try {
    if (typeof navigator !== 'undefined' && navigator?.userAgent === 'Cloudflare-Workers') kind = 'workerd';
    else if (typeof EdgeRuntime !== 'undefined') kind = 'workerd';
    else if (typeof Deno !== 'undefined') kind = 'deno';
    else if (typeof Bun !== 'undefined') kind = 'bun';
    else if (typeof process !== 'undefined' && process?.versions?.node !== undefined) kind = 'node';
    else if (typeof window !== 'undefined') kind = 'browser';
  } catch {
    kind = 'unknown';
  }
  cached = kind;
  return kind;
}

/** For tests. */
export function __resetRuntimeDetection(): void {
  cached = null;
}

export function isWorkerd(): boolean {
  return detectRuntime() === 'workerd';
}

export function isNode(): boolean {
  return detectRuntime() === 'node';
}

export function isBrowser(): boolean {
  return detectRuntime() === 'browser';
}

/** Reads an environment value from Workers `env`, `process.env`, or both. */
export function readEnv(env: Record<string, unknown> | undefined, name: string): string | undefined {
  const fromEnv = env?.[name];
  if (typeof fromEnv === 'string') return fromEnv;
  try {
    const p = typeof process !== 'undefined' ? process?.env?.[name] : undefined;
    if (typeof p === 'string') return p;
  } catch {
    // process is not defined in some runtimes
  }
  return undefined;
}

export type NodeEnvironment = 'development' | 'production' | 'test';

/** Resolves NODE_ENV / NEXTJS_ENV semantics consistently across runtimes. */
export function nodeEnvironment(env?: Record<string, unknown>): NodeEnvironment {
  const value = readEnv(env, 'NODE_ENV') ?? readEnv(env, 'NEXTJS_ENV') ?? 'production';
  if (value === 'development' || value === 'test') return value;
  return 'production';
}

export function isDevelopment(env?: Record<string, unknown>): boolean {
  return nodeEnvironment(env) === 'development';
}

/** `performance.now()` with a fallback. */
export function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

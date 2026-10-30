import {
  type FlagDefinition,
  type FlagRule,
  type FlagValue,
  type HypDrivEnv,
  type KVNamespaceLike,
  type Logger,
  memoizeAsync,
  type ResolvedConfig,
} from '@hypdriv/core';
import { isFlagValue } from './encoding';
import { evaluateFlags, type FlagEvalInput, type FlagEvalResult, flagType } from './evaluate';

/** Supplies flag definitions to the `flags` stage; remote providers may also evaluate. */
export interface FlagProvider {
  /** Short identifier for logs and the HUD (`static`, `env`, `kv`, `openfeature`). */
  readonly name: string;
  /** Returns the current definitions. Providers cache internally; called on every request. */
  load(): Promise<Record<string, FlagDefinition>>;
  /** Notifies when definitions change (not supported by all providers). */
  subscribe?(callback: () => void): () => void;
  /** Remote evaluation. When present, the stage calls it instead of the local `evaluateFlags`. */
  evaluate?(input: FlagEvalInput): Promise<FlagEvalResult>;
  /** Drops cached definitions so the next `load()` refetches. */
  invalidate?(): void;
}

export interface ProviderOptions {
  log?: Logger;
}

/** Validates JSON from an untrusted source (env var, KV) and drops malformed definitions. */
export function parseFlagDefinitions(
  input: unknown,
  onInvalid?: (name: string, reason: string) => void,
): Record<string, FlagDefinition> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, FlagDefinition> = {};
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = normalizeDefinition(raw);
    if (def) out[name] = def;
    else onInvalid?.(name, 'definition must be an object with a boolean, string or number `default`');
  }
  return out;
}

function normalizeDefinition(raw: unknown): FlagDefinition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isFlagValue(r.default)) return null;
  const def: FlagDefinition = { default: r.default };
  if (typeof r.description === 'string') def.description = r.description;
  if (r.serverOnly === true) def.serverOnly = true;
  if (Array.isArray(r.rules)) {
    const rules: FlagRule[] = [];
    for (const rule of r.rules) {
      if (!rule || typeof rule !== 'object') continue;
      const candidate = rule as Record<string, unknown>;
      if (!isFlagValue(candidate.value)) continue;
      const normalized: FlagRule = { value: candidate.value };
      if (candidate.when && typeof candidate.when === 'object')
        normalized.when = candidate.when as FlagRule['when'];
      if (typeof candidate.percentage === 'number') normalized.percentage = candidate.percentage;
      rules.push(normalized);
    }
    def.rules = rules;
  }
  return def;
}

/** Definitions from `hypdriv.config.ts` only. */
export function staticProvider(definitions: Record<string, FlagDefinition>): FlagProvider {
  return {
    name: 'static',
    load: async () => definitions,
  };
}

/**
 * Definitions from a JSON environment variable (`HYPDRIV_FLAGS` by default) merged over the
 * fallback definitions from config. Invalid JSON falls back to the config definitions and warns once.
 */
export function envProvider(
  env: HypDrivEnv | Record<string, unknown> | undefined,
  envVar: string,
  fallback: Record<string, FlagDefinition>,
  options: ProviderOptions = {},
): FlagProvider {
  let lastRaw: string | undefined;
  let cached: Record<string, FlagDefinition> = fallback;
  let warned = false;
  const warn = (message: string, fields?: Record<string, unknown>) => {
    if (warned) return;
    warned = true;
    if (options.log) options.log.warn(message, fields);
    else console.warn(`[hypdriv/flags] ${message}`, fields ?? '');
  };
  const read = (): string | undefined => {
    const fromEnv = env?.[envVar];
    if (typeof fromEnv === 'string') return fromEnv;
    try {
      const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      const value = p?.env?.[envVar];
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    name: 'env',
    async load() {
      const raw = read();
      if (raw === lastRaw) return cached;
      lastRaw = raw;
      if (raw === undefined || raw.trim() === '') {
        cached = fallback;
        return cached;
      }
      try {
        const parsed = parseFlagDefinitions(JSON.parse(raw), (name, reason) =>
          warn(`Ignoring flag "${name}" from ${envVar}: ${reason}`),
        );
        if (!parsed) throw new TypeError('expected a JSON object of flag definitions');
        cached = { ...fallback, ...parsed };
      } catch (err) {
        warn(`Invalid JSON in ${envVar}; using config definitions`, {
          error: err instanceof Error ? err.message : String(err),
        });
        cached = fallback;
      }
      return cached;
    },
    invalidate() {
      lastRaw = undefined;
    },
  };
}

/**
 * Definitions from a KV key (JSON object), merged over the fallback definitions and refreshed at most
 * every `refreshSeconds` per isolate (concurrent misses coalesce). A failing or missing key keeps
 * serving the last good definitions (or the fallback).
 */
export function kvProvider(
  kv: KVNamespaceLike,
  key: string,
  fallback: Record<string, FlagDefinition>,
  refreshSeconds: number,
  options: ProviderOptions & { now?: () => number } = {},
): FlagProvider {
  let lastGood: Record<string, FlagDefinition> | null = null;
  const ttlMs = Math.max(0, refreshSeconds) * 1000;
  const memo = memoizeAsync<Record<string, FlagDefinition>>(
    async () => {
      try {
        const raw = await kv.get(key, 'json');
        // A missing key is a decision (overrides removed), not an outage: back to the config definitions.
        if (raw === null || raw === undefined) {
          lastGood = null;
          return fallback;
        }
        const parsed = parseFlagDefinitions(raw, (name, reason) =>
          options.log?.warn(`Ignoring flag "${name}" from KV ${key}: ${reason}`),
        );
        if (!parsed) {
          options.log?.warn(`KV key ${key} is not a JSON object of flag definitions`);
          return lastGood ?? fallback;
        }
        lastGood = { ...fallback, ...parsed };
        return lastGood;
      } catch (err) {
        options.log?.warn(`Failed to read flags from KV ${key}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood ?? fallback;
      }
    },
    ttlMs,
    options.now,
  );
  return {
    name: 'kv',
    load: () => memo.get(key),
    invalidate: () => memo.invalidate(),
  };
}

/** The subset of an OpenFeature client HypDriv calls. */
export interface OpenFeatureClientLike {
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: Record<string, unknown>,
  ): Promise<boolean>;
  getStringValue(flagKey: string, defaultValue: string, context?: Record<string, unknown>): Promise<string>;
  getNumberValue(flagKey: string, defaultValue: number, context?: Record<string, unknown>): Promise<number>;
}

export interface OpenFeatureProviderOptions extends ProviderOptions {
  /** Extra evaluation-context attributes merged into every call. */
  context?: (input: FlagEvalInput) => Record<string, unknown>;
}

/**
 * Evaluates each definition through an OpenFeature client (`getBooleanValue`/`getStringValue`/
 * `getNumberValue` by the default's type). The evaluation context carries `targetingKey` (the stable
 * id), `country`, `continent`, `path` and `device`. Local overrides still win; when the client throws
 * for a flag, the local rules decide (reason `openfeature-error`).
 */
export function openFeatureProvider(
  client: OpenFeatureClientLike,
  definitions: Record<string, FlagDefinition>,
  options: OpenFeatureProviderOptions = {},
): FlagProvider {
  return {
    name: 'openfeature',
    load: async () => definitions,
    async evaluate(input) {
      const local = evaluateFlags(input);
      const context: Record<string, unknown> = {
        targetingKey: input.stableId,
        country: input.geo?.country,
        continent: input.geo?.continent,
        path: input.url.pathname,
        device: input.device,
        ...(options.context?.(input) ?? {}),
      };
      const values: Record<string, FlagValue> = {};
      const reasons: Record<string, string> = {};
      await Promise.all(
        Object.entries(input.definitions).map(async ([name, def]) => {
          if (local.reasons[name] === 'override') {
            values[name] = local.values[name]!;
            reasons[name] = 'override';
            return;
          }
          try {
            const type = flagType(def);
            const value =
              type === 'boolean'
                ? await client.getBooleanValue(name, def.default as boolean, context)
                : type === 'number'
                  ? await client.getNumberValue(name, def.default as number, context)
                  : await client.getStringValue(name, String(def.default), context);
            values[name] = isFlagValue(value) ? value : def.default;
            reasons[name] = 'openfeature';
          } catch (err) {
            options.log?.warn(`OpenFeature evaluation failed for "${name}"`, {
              error: err instanceof Error ? err.message : String(err),
            });
            values[name] = local.values[name] ?? def.default;
            reasons[name] = 'openfeature-error';
          }
        }),
      );
      return { values, reasons };
    },
  };
}

export interface CreateFlagProviderOptions extends ProviderOptions {
  /** Required for `provider: 'openfeature'`; supplied by the application at runtime. */
  openFeatureClient?: OpenFeatureClientLike;
}

/**
 * Picks the provider declared in `config.flags.provider` and wires it to `env`. Missing upgrades
 * (no KV binding, no OpenFeature client) degrade to the static definitions with a warning.
 */
export function createFlagProvider(
  config: ResolvedConfig,
  env: HypDrivEnv | Record<string, unknown> | undefined,
  options: CreateFlagProviderOptions = {},
): FlagProvider {
  const f = config.flags;
  switch (f.provider) {
    case 'env':
      return envProvider(env, f.envVar, f.definitions, options);
    case 'kv': {
      const kv = env?.[f.kvBinding];
      if (isKvLike(kv)) return kvProvider(kv, f.kvKey, f.definitions, f.refreshSeconds, options);
      options.log?.warn(
        `flags.provider is "kv" but binding ${f.kvBinding} is missing; using static definitions`,
      );
      return staticProvider(f.definitions);
    }
    case 'openfeature': {
      if (options.openFeatureClient)
        return openFeatureProvider(options.openFeatureClient, f.definitions, options);
      options.log?.warn(
        'flags.provider is "openfeature" but no client was supplied; using static definitions',
      );
      return staticProvider(f.definitions);
    }
    default:
      return staticProvider(f.definitions);
  }
}

function isKvLike(value: unknown): value is KVNamespaceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KVNamespaceLike).get === 'function' &&
    typeof (value as KVNamespaceLike).put === 'function'
  );
}

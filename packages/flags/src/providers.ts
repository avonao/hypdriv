import {
  EXPERIMENT_TOKEN_RE,
  type ExperimentSpec,
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
    if (!def) {
      onInvalid?.(
        name,
        'ignored: the definition must be an object with a boolean, string or number `default`',
      );
      continue;
    }
    // Experiment names are stored in a cookie: one that cannot be would be counted again on every page view.
    if (def.experiment && !EXPERIMENT_TOKEN_RE.test(name)) {
      delete def.experiment;
      onInvalid?.(
        name,
        'its experiment block is ignored (the flag serves its default): experiment names must be 1–48 letters, digits, "_" or "-"',
      );
    } else if (isExperimentBlock(raw) && !def.experiment) {
      onInvalid?.(
        name,
        'its experiment block is ignored (the flag serves its default): it needs two or more variants named with letters, digits, "_" or "-" and a default that is one of them',
      );
    }
    out[name] = def;
  }
  return out;
}

function isExperimentBlock(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    !!(raw as { experiment?: unknown }).experiment &&
    typeof (raw as { experiment?: unknown }).experiment === 'object'
  );
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
  const experiment = normalizeExperiment(r.experiment, def.default);
  if (experiment) def.experiment = experiment;
  return def;
}

/** A remote definition's `experiment` block, or `undefined` when it is missing or unusable (then it is a plain flag). */
function normalizeExperiment(raw: unknown, control: FlagValue): ExperimentSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!r.variants || typeof r.variants !== 'object' || Array.isArray(r.variants)) return undefined;
  const variants: Record<string, number> = {};
  for (const [variant, weight] of Object.entries(r.variants as Record<string, unknown>))
    if (
      EXPERIMENT_TOKEN_RE.test(variant) &&
      variant !== '__proto__' &&
      typeof weight === 'number' &&
      Number.isFinite(weight) &&
      weight > 0
    )
      variants[variant] = weight;
  if (Object.keys(variants).length < 2 || typeof control !== 'string' || !Object.hasOwn(variants, control))
    return undefined;
  const spec: ExperimentSpec = { variants };
  if (typeof r.traffic === 'number' && Number.isFinite(r.traffic))
    spec.traffic = Math.min(Math.max(r.traffic, 0), 100);
  if (r.when && typeof r.when === 'object' && !Array.isArray(r.when)) spec.when = r.when as FlagRule['when'];
  if (typeof r.salt === 'string') spec.salt = r.salt.slice(0, 64);
  if (r.status === 'running' || r.status === 'paused' || r.status === 'concluded') spec.status = r.status;
  if (typeof r.winner === 'string' && Object.hasOwn(variants, r.winner)) spec.winner = r.winner;
  if (Array.isArray(r.expose))
    spec.expose = r.expose.filter((p): p is string => typeof p === 'string').slice(0, 32);
  return spec;
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
          warn(`Flag "${name}" from ${envVar}: ${reason}`),
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
          options.log?.warn(`Flag "${name}" from KV ${key}: ${reason}`),
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

/** The subset of an OpenFeature client Hypdriv calls. */
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
          // Experiments are assigned at the edge (sticky, exposure-counted); OpenFeature does not see them.
          if (local.experiments[name]) {
            values[name] = local.values[name]!;
            reasons[name] = local.reasons[name]!;
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
      return { values, reasons, experiments: local.experiments };
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

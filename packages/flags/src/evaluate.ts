import {
  bucketPercent,
  type FlagDefinition,
  type FlagRule,
  type FlagValue,
  type GeoProperties,
  matchesAny,
} from '@hypdriv/core';
import { isFlagValue } from './encoding';

/** Device class used by `when.device` rules. */
export type FlagDevice = 'mobile' | 'desktop' | 'bot';

/** Everything the evaluator needs about one request. */
export interface FlagEvalInput {
  definitions: Record<string, FlagDefinition>;
  /** Stable per-visitor id (the `hyp_uid` cookie); drives deterministic percentage bucketing. */
  stableId: string;
  url: URL;
  headers: Headers;
  cookies: Record<string, string>;
  geo?: GeoProperties;
  device?: FlagDevice;
  /** Evaluation time for `from`/`until` windows (default: now). */
  now?: Date;
  /** Explicit overrides (QA query parameters, tests). They win over rules and defaults. */
  overrides?: Record<string, FlagValue>;
}

export interface FlagEvalResult {
  values: Record<string, FlagValue>;
  /**
   * Why each flag has its value: `default`, `rule:<index>`, `override`,
   * `percentage-miss:<index>` (a rule's conditions matched but the visitor fell outside its
   * percentage and no later rule matched) or a provider-specific reason (`openfeature`).
   */
  reasons: Record<string, string>;
}

export type FlagType = 'boolean' | 'string' | 'number';

/** The type of a flag is the type of its default value. */
export function flagType(definition: FlagDefinition): FlagType {
  const d = definition.default;
  return typeof d === 'boolean' ? 'boolean' : typeof d === 'number' ? 'number' : 'string';
}

const TRUE_WORDS = new Set(['true', '1', 'on', 'yes', 'enabled']);
const FALSE_WORDS = new Set(['false', '0', 'off', 'no', 'disabled']);

/**
 * Coerces a raw override (usually a query-string value) to a flag type. Returns `undefined` when the
 * value cannot be represented in that type, in which case the override is ignored.
 */
export function coerceFlagValue(raw: unknown, type: FlagType): FlagValue | undefined {
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    if (typeof raw === 'string') {
      const word = raw.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
    }
    return undefined;
  }
  if (type === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

/** Query parameter prefix for QA overrides: `?hyp_flag_<name>=<value>`. */
export const FLAG_QUERY_PREFIX = 'hyp_flag_';

/**
 * Extracts `?hyp_flag_<name>=<value>` overrides for known definitions. Unknown names are ignored so a
 * URL can never inject flags the application did not declare. Values are coerced by `evaluateFlags`.
 */
export function parseQueryOverrides(
  url: URL,
  definitions: Record<string, FlagDefinition>,
  prefix: string = FLAG_QUERY_PREFIX,
): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  for (const [key, value] of url.searchParams) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (name in definitions) out[name] = value;
  }
  return out;
}

/** Removes `serverOnly` flags: what may be sent to the browser (`FlagsProvider`, meta tags). */
export function publicFlags(
  values: Record<string, FlagValue>,
  definitions: Record<string, FlagDefinition>,
): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (definitions[name]?.serverOnly) continue;
    out[name] = value;
  }
  return out;
}

/** `true` when at least one definition needs the stable id (percentage rollouts). */
export function needsStableId(definitions: Record<string, FlagDefinition>): boolean {
  for (const def of Object.values(definitions)) {
    for (const rule of def.rules ?? []) if (rule.percentage !== undefined) return true;
  }
  return false;
}

type RuleOutcome = 'match' | 'no-match' | 'percentage-miss';

/**
 * Evaluates every definition for one request.
 *
 * Order of precedence per flag: override → first matching rule (in definition order) → default.
 * A rule matches when every `when` condition holds and, when `percentage` is set, the visitor's
 * deterministic bucket (`bucketPercent(stableId, flagName)`) is below it. `when.flag` dependencies
 * are resolved lazily; a circular dependency never matches.
 */
export function evaluateFlags(input: FlagEvalInput): FlagEvalResult {
  const values: Record<string, FlagValue> = {};
  const reasons: Record<string, string> = {};
  const now = input.now ?? new Date();
  const { definitions } = input;

  const evaluate = (name: string, stack: readonly string[]): FlagValue | undefined => {
    if (Object.hasOwn(values, name)) return values[name];
    const def = definitions[name];
    if (!def) return undefined;
    if (stack.includes(name)) return undefined; // cycle: the dependency condition fails

    const override = input.overrides?.[name];
    if (override !== undefined) {
      const coerced = coerceFlagValue(override, flagType(def));
      if (coerced !== undefined) {
        values[name] = coerced;
        reasons[name] = 'override';
        return coerced;
      }
    }

    const nextStack = [...stack, name];
    let percentageMiss = -1;
    const rules = def.rules ?? [];
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index]!;
      const outcome = evaluateRule(rule, name, input, now, (dep) => evaluate(dep, nextStack));
      if (outcome === 'match') {
        values[name] = rule.value;
        reasons[name] = `rule:${index}`;
        return rule.value;
      }
      if (outcome === 'percentage-miss' && percentageMiss === -1) percentageMiss = index;
    }
    values[name] = def.default;
    reasons[name] = percentageMiss >= 0 ? `percentage-miss:${percentageMiss}` : 'default';
    return def.default;
  };

  for (const name of Object.keys(definitions)) evaluate(name, []);
  return { values, reasons };
}

/** Evaluates a single flag (convenience for tests and server helpers). */
export function evaluateFlag(
  name: string,
  input: FlagEvalInput,
): { value: FlagValue; reason: string } | null {
  if (!(name in input.definitions)) return null;
  const result = evaluateFlags(input);
  const value = result.values[name];
  if (value === undefined) return null;
  return { value, reason: result.reasons[name] ?? 'default' };
}

function evaluateRule(
  rule: FlagRule,
  flagName: string,
  input: FlagEvalInput,
  now: Date,
  resolve: (dependency: string) => FlagValue | undefined,
): RuleOutcome {
  if (!conditionsHold(rule, input, now, resolve)) return 'no-match';
  if (rule.percentage !== undefined) {
    const pct = Number.isFinite(rule.percentage) ? Math.min(Math.max(rule.percentage, 0), 100) : 0;
    if (pct <= 0) return 'percentage-miss';
    if (pct < 100 && !(bucketPercent(input.stableId, flagName) < pct)) return 'percentage-miss';
  }
  return 'match';
}

function conditionsHold(
  rule: FlagRule,
  input: FlagEvalInput,
  now: Date,
  resolve: (dependency: string) => FlagValue | undefined,
): boolean {
  const when = rule.when;
  if (!when) return true;
  if (when.country && !inCodeList(input.geo?.country, when.country)) return false;
  if (when.continent && !inCodeList(input.geo?.continent, when.continent)) return false;
  if (when.path && !matchesAny(when.path, input.url)) return false;
  if (when.device && when.device !== input.device) return false;
  if (when.cookie) {
    for (const [name, expected] of Object.entries(when.cookie)) {
      if (!valueMatches(input.cookies[name], expected)) return false;
    }
  }
  if (when.header) {
    for (const [name, expected] of Object.entries(when.header)) {
      if (!valueMatches(input.headers.get(name)?.trim(), expected)) return false;
    }
  }
  if (when.from !== undefined) {
    const from = parseIso(when.from);
    if (from === null || now.getTime() < from) return false;
  }
  if (when.until !== undefined) {
    const until = parseIso(when.until);
    if (until === null || now.getTime() >= until) return false;
  }
  if (when.flag) {
    for (const [dependency, expected] of Object.entries(when.flag)) {
      const actual = resolve(dependency);
      if (actual === undefined || !isFlagValue(expected) || actual !== expected) return false;
    }
  }
  return true;
}

function inCodeList(actual: string | undefined, list: string[]): boolean {
  if (!actual) return false;
  const upper = actual.toUpperCase();
  return list.some((code) => code.toUpperCase() === upper);
}

function valueMatches(actual: string | undefined, expected: string | string[]): boolean {
  if (actual === undefined) return false;
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

function parseIso(value: string): number | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

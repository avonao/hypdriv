/**
 * `@hypdriv/flags` — edge feature flags for Hypdriv.
 *
 * - `evaluateFlags()` is the pure evaluator (rules, deterministic percentage buckets, dependencies,
 *   date windows, overrides).
 * - Providers supply definitions: `staticProvider`, `envProvider`, `kvProvider`, `openFeatureProvider`,
 *   or `createFlagProvider(config, env)` to pick the one configured in `hypdriv.config.ts`.
 * - `flagsStage(config, provider)` is the Drivetrain stage that evaluates per request, sets the
 *   `hyp_uid` cookie once and forwards values in `x-hypdriv-flags`.
 * - `encodeFlagsHeader` / `decodeFlagsHeader` / `flagsFromHeaders` are the transport encoding the
 *   server helpers (`@hypdriv/next`) and DevTools use.
 */

export {
  decodeFlagsHeader,
  encodeFlagsHeader,
  flagsFromHeaders,
  isFlagValue,
  sanitizeFlagValues,
} from './encoding';
export {
  coerceFlagValue,
  evaluateFlag,
  evaluateFlags,
  FLAG_QUERY_PREFIX,
  type FlagDevice,
  type FlagEvalInput,
  type FlagEvalResult,
  type FlagType,
  flagType,
  needsStableId,
  parseQueryOverrides,
  publicFlags,
} from './evaluate';
export {
  type CreateFlagProviderOptions,
  createFlagProvider,
  envProvider,
  type FlagProvider,
  kvProvider,
  type OpenFeatureClientLike,
  type OpenFeatureProviderOptions,
  openFeatureProvider,
  type ProviderOptions,
  parseFlagDefinitions,
  staticProvider,
} from './providers';
export {
  detectDevice,
  FLAG_ID_KEY,
  FLAG_REASONS_KEY,
  FLAGS_KEY,
  type FlagsStageOptions,
  flagsStage,
  geoForFlags,
} from './stage';

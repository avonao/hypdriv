import {
  createRouteMatcher,
  experimentControl,
  type FlagValue,
  type HypManifest,
  MAX_EXPERIMENT_COPIES,
  type ResolvedConfig,
  type ResolvedEdgeCachePolicy,
} from '@hypdriv/core';
import { matchPolicyFor, resolvePolicies } from './policies';

/** Values of the vary dimensions that the key of one cache copy was built from (see `CacheKeyInput`). */
export interface VariantInput {
  flags?: Record<string, FlagValue>;
  locale?: string;
  device?: string;
}

/** The most variant copies of one URL that a purge looks for by key (the rest is reached through the path tag). */
export const MAX_PURGE_VARIANTS = 64;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Every value a flag can take, as far as the configuration knows; `[]` for a flag only a remote provider defines. */
function flagValues(config: ResolvedConfig, name: string): FlagValue[] {
  const def = Object.hasOwn(config.flags.definitions, name) ? config.flags.definitions[name] : undefined;
  if (!def) return [];
  if (def.experiment) return Object.keys(def.experiment.variants);
  return unique([def.default, ...(def.rules ?? []).map((rule) => rule.value)]);
}

/**
 * The variant copies a policy can hold for one URL, other than the base key (no flag values, no locale, no device
 * class): the product of the values each dimension can take, as far as the configuration knows them. Used by URL
 * purges to reach every variant copy by its key, without needing a tag index shared between isolates. Dimensions with
 * no finite set of values (cookies, headers, geo) are reached through the `path:` tag only. `[]` when there is no
 * variant dimension, or when the product exceeds `cap`.
 */
export function enumerateVariantInputs(
  policy: Pick<ResolvedEdgeCachePolicy, 'vary'>,
  config: ResolvedConfig,
  cap: number = MAX_PURGE_VARIANTS,
): VariantInput[] {
  // Each dimension is a list of alternatives: "absent" first (the base key), then every value it can take.
  const dimensions: Array<Array<(input: VariantInput) => VariantInput>> = [];
  for (const name of [...policy.vary.flags].sort()) {
    const values = flagValues(config, name);
    if (!values.length) continue;
    dimensions.push([
      (input) => input,
      ...values.map((value) => (input: VariantInput) => ({
        ...input,
        flags: { ...input.flags, [name]: value },
      })),
    ]);
  }
  if (policy.vary.language && config.i18n) {
    const locales = unique([config.i18n.defaultLocale, ...config.i18n.locales]);
    dimensions.push([
      (input) => input,
      ...locales.map((locale) => (input: VariantInput) => ({ ...input, locale })),
    ]);
  }
  if (policy.vary.device)
    dimensions.push([
      (input) => input,
      ...['mobile', 'desktop'].map((device) => (input: VariantInput) => ({ ...input, device })),
    ]);
  if (!dimensions.length) return [];
  const total = dimensions.reduce((n, d) => n * d.length, 1);
  if (total - 1 > cap) return [];
  let combos: VariantInput[] = [{}];
  for (const dimension of dimensions)
    combos = combos.flatMap((combo) => dimension.map((apply) => apply(combo)));
  // The first combination is the base key itself (nothing set).
  return combos.slice(1);
}

/** Variant → assignment of every running experiment a policy's pages depend on. */
export type ExperimentAssignment = Record<string, string>;

/** The variants of one experiment, the control first. */
function orderedVariants(config: ResolvedConfig, name: string): string[] {
  const def = config.flags.definitions[name];
  const spec = def?.experiment;
  if (!def || !spec) return [];
  const control = experimentControl(def, spec);
  return [control, ...Object.keys(spec.variants).filter((variant) => variant !== control)];
}

/**
 * For a path, the experiment assignments a warm-up has to cover so that every cached copy of the page is filled: the
 * running experiments the matching policy varies on, as the product of their variants (all-control first), at most
 * `cap` combinations. `[{}]` (one plain request) when the page does not depend on an experiment or no policy keeps it.
 * Experiments that only a remote provider defines are not known here.
 */
export function createWarmVariantPlanner(
  config: ResolvedConfig,
  manifest: HypManifest,
  cap: number = MAX_EXPERIMENT_COPIES,
): (pathname: string) => ExperimentAssignment[] {
  const policies = resolvePolicies(config, manifest);
  const matcher = createRouteMatcher(manifest);
  const cache = new Map<string, ExperimentAssignment[]>();
  return (pathname) => {
    const url = new URL(pathname, 'https://hypdriv.internal');
    const policy = matchPolicyFor(policies, url, matcher.match(url.pathname), manifest.basePath);
    if (!policy) return [{}];
    const names = policy.vary.flags
      .filter((name) => config.flags.definitions[name]?.experiment?.status !== 'concluded')
      .filter((name) => orderedVariants(config, name).length > 0)
      .sort();
    if (!names.length) return [{}];
    const key = names.join('|');
    let planned = cache.get(key);
    if (!planned) {
      let combos: ExperimentAssignment[] = [{}];
      for (const name of names)
        combos = combos.flatMap((combo) =>
          orderedVariants(config, name).map((variant) => ({ ...combo, [name]: variant })),
        );
      planned = combos.slice(0, Math.max(1, cap));
      cache.set(key, planned);
    }
    return planned;
  };
}

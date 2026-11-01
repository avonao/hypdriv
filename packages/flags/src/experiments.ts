import {
  bucketPercent,
  type ExperimentMembership,
  type ExperimentSpec,
  experimentControl,
  experimentGeneration,
  type FlagDefinition,
  matchesAny,
} from '@hypdriv/core';

/** How long the experiment cookie lives: 180 days from its last write. */
export const EXPERIMENT_COOKIE_SECONDS = 180 * 24 * 60 * 60;

/**
 * Who is asking. Only a `visitor` is assigned, remembered and counted:
 * - `bot`: a crawler, preview fetcher or the owner's audit tooling — always the control;
 * - `warm`: a cache warm-up (`x-hypdriv-warm`) — the variants its cookie names, so that each cached copy can be
 *   filled, and the control for the rest.
 */
export type ExperimentRequester = 'visitor' | 'bot' | 'warm';

/**
 * Why a visitor has the variant they have:
 * - `variant`: freshly assigned by weight; `sticky`: kept from the experiment cookie;
 * - `excluded`: outside the audience (`when`) — control; `holdout`: outside the traffic share — control;
 * - `paused`: the experiment is paused and the visitor has no variant yet — control;
 * - `concluded`: everyone gets the winner (or the control);
 * - `bot` / `warm`: not a visitor (see {@link ExperimentRequester}).
 */
export type ExperimentReason =
  | 'variant'
  | 'sticky'
  | 'excluded'
  | 'holdout'
  | 'paused'
  | 'concluded'
  | 'bot'
  | 'warm';

export interface ExperimentOutcome {
  variant: string;
  reason: ExperimentReason;
  /** The visitor takes part (a measured assignment): `variant` or `sticky`. */
  member: boolean;
}

export interface ExperimentInput {
  stableId: string;
  /** The visitor's memberships from the experiment cookie. */
  memberships?: Record<string, ExperimentMembership>;
  /** `true` when the audience conditions (`experiment.when`) hold for this request. */
  inAudience: boolean;
  /** Who is asking (default `visitor`). */
  requester?: ExperimentRequester;
}

/** Picks a variant by weight for a bucket in [0, 100). Ignores non-positive weights. */
export function pickVariant(variants: Record<string, number>, bucket: number): string {
  const entries = Object.entries(variants).filter(([, w]) => Number.isFinite(w) && w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0 || entries.length === 0) return Object.keys(variants)[0] ?? '';
  const point = (Math.min(Math.max(bucket, 0), 99.999) / 100) * total;
  let acc = 0;
  for (const [variant, weight] of entries) {
    acc += weight;
    if (point < acc) return variant;
  }
  return entries[entries.length - 1]?.[0] ?? '';
}

/** Whether a variant name is one the experiment currently has. */
export function hasVariant(spec: ExperimentSpec, variant: unknown): variant is string {
  return typeof variant === 'string' && Object.hasOwn(spec.variants, variant);
}

/**
 * Assigns one visitor. Deterministic: the same stable id gets the same variant for the same name and salt, so no
 * state is needed to stay consistent; the cookie only keeps an assignment when weights, traffic or variants change
 * later. The order of the checks is the contract:
 *
 * 1. `concluded`: everyone gets the winner.
 * 2. Not a visitor (bot, warm-up): never assigned or counted.
 * 3. The audience, before anything stored: an old cookie cannot override a condition (consent) that no longer holds.
 * 4. A stored assignment of the current restart (`salt`) that still names a variant.
 * 5. `paused` gives new visitors the control; otherwise the traffic share and the weights decide.
 */
export function evaluateExperiment(
  name: string,
  def: FlagDefinition,
  spec: ExperimentSpec,
  input: ExperimentInput,
): ExperimentOutcome {
  const control = experimentControl(def, spec);
  const status = spec.status ?? 'running';
  if (status === 'concluded') {
    const winner = hasVariant(spec, spec.winner) ? spec.winner : control;
    return { variant: winner, reason: 'concluded', member: false };
  }
  const requester = input.requester ?? 'visitor';
  if (requester === 'bot') return { variant: control, reason: 'bot', member: false };
  if (requester === 'warm') {
    const forced = input.memberships?.[name]?.variant;
    return { variant: hasVariant(spec, forced) ? forced : control, reason: 'warm', member: false };
  }
  if (!input.inAudience) return { variant: control, reason: 'excluded', member: false };
  const stored = input.memberships?.[name];
  const salt = spec.salt ?? '';
  if (stored && hasVariant(spec, stored.variant) && (stored.generation ?? '') === experimentGeneration(salt))
    return { variant: stored.variant, reason: 'sticky', member: true };
  if (status === 'paused') return { variant: control, reason: 'paused', member: false };

  const traffic = spec.traffic === undefined ? 100 : Math.min(Math.max(spec.traffic, 0), 100);
  if (traffic < 100 && !(bucketPercent(input.stableId, `${name}:traffic:${salt}`) < traffic))
    return { variant: control, reason: 'holdout', member: false };
  const variant = pickVariant(spec.variants, bucketPercent(input.stableId, `${name}:variant:${salt}`));
  return { variant, reason: 'variant', member: true };
}

/** Whether a page view on this path counts as an exposure (`experiment.expose`, default: any page). */
export function exposesOn(spec: ExperimentSpec, url: URL): boolean {
  return !spec.expose?.length || matchesAny(spec.expose, url);
}

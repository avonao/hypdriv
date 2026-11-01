# ADR 0022 — Edge A/B experiments are flags with an `experiment` block

**Status:** accepted · **Date:** 2026-11-01

## Context

Flags already give deterministic, sticky percentage rollouts at the edge. A/B testing needs more than a rollout: named variants with weights, a record of who was exposed to what, a cache that does not show one visitor another's variant, and a way to read the outcome. The platform constraints are fixed by the rest of Hypdriv: no mandatory infrastructure (ADR 0004), the same behaviour on Workers, Vercel and Node (ADR 0013), no stored visitor identity beyond what a flag already uses.

## Decision

1. **An experiment is a flag.** `FlagDefinition.experiment` adds `variants` (weights), `traffic`, `when` (audience), `salt`, `status`, `winner` and `expose`; the flag's value is the variant and `default` is the control. Everything that works with flags (`flag()`, `useFlag()`, the `x-hypdriv-flags` header, `vary.flags`, `?hyp_flag_` QA overrides, DevTools) works with experiments, and nothing in an application changes to read one.
2. **Assignment is a pure function of `hash(stableId, name, salt)`**, so any instance reaches the same answer. A first-party cookie (`hyp_exp`, `name:variant` pairs, a `*` marking a counted visitor, 180 days) keeps the assignment when weights, traffic or audience change, and remembers that the exposure was counted. Paused and concluded states are evaluated, not stored.
3. **Exposures are rows, not identities.** The flags stage reports the first page view (HTML or RSC, `GET`, 2xx, not a prefetch) of a member once per visitor and experiment to an `ExposureSink`: Analytics Engine when bound, the log otherwise (`flags.exposures`). The row carries experiment, variant, path, route, country and build; counting rows counts visitors, so no visitor id is stored.
4. **Vitals are sliced at the beacon.** The vitals route reads the experiment cookie and tags the payload; the body's own `experiments` field is discarded. The Analytics Engine sink stores the tag as `blob8`, delimited at both ends so a `position()` match is exact. Exposures and vitals share one dataset, multiplexed by `blob1`, which keeps a deployment to one binding and one query credential.
5. **The cache is correct by default.** Policies (explicit and inferred) vary on every running experiment unless `vary.experiments: false`; concluded experiments drop out of the key. The cost is a multiplier on cached copies, which `hypdriv doctor` reports and bounds (warn above 16).
6. **The report guards its own validity.** `hypdriv experiments --results` compares observed visitors to the weights with a χ² test (p < 0.001 is a sample ratio mismatch, exit code 1) before showing any metric, because a broken split invalidates every comparison below it. It reports Core Web Vitals per variant, not business outcomes, which live in the application's analytics.

## Consequences

- No new package: the types and the cookie codec are in `@hypdriv/core`, assignment and exposure sinks in `@hypdriv/flags`, tagging and the SQL/statistics in `@hypdriv/observe`, the command and checks in `@hypdriv/cli`.
- Statistical significance of metric differences is not computed; the report is a guard against a broken experiment and a quick look at performance, not a replacement for the analysis of the business metric.
- Remote-provider experiments (KV, OpenFeature) are evaluated like local ones but are not known when the config resolves, so edge cache policies need them listed in `vary.flags`.
- EU consent for the functional cookie is the operator's call; the documented pattern is an audience rule on the consent cookie.

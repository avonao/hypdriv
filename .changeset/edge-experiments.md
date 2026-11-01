---
"@hypdriv/core": minor
"@hypdriv/flags": minor
"@hypdriv/runtime": minor
"@hypdriv/observe": minor
"@hypdriv/cache": minor
"@hypdriv/cli": minor
---

Edge A/B experiments. A flag definition with an `experiment` block (weighted `variants`, `traffic`, an audience `when`, `salt`, `status` running / paused / concluded with a `winner`, `expose` paths) is assigned at the edge, deterministically per stable visitor id and kept sticky in the first-party `hyp_exp` cookie. The first page view of a member is reported once per visitor and experiment as an exposure: Analytics Engine when `HYPDRIV_ANALYTICS` is bound, the log otherwise (`flags.exposures`, `flags.exposuresBinding`, `flags.experimentCookie`). The vitals beacon route tags measurements with the visitor's variants from the cookie (eighth Analytics Engine blob). Edge cache policies, explicit and inferred, vary on every running experiment by default (`vary.experiments`), so a cached page never shows another visitor's variant. `hypdriv experiments` lists the configured experiments and, with `--results`, reports visitors per variant against the weights (χ² sample ratio check, exit code 1 on a mismatch) and p75 LCP / INP / CLS per variant; `hypdriv doctor` checks the cache multiplier, the exposure destination and the vitals sink. `@hypdriv/observe` exports `experimentExposuresSql`, `experimentVitalsSql`, `sampleRatioCheck`, `chiSquareSurvival` and `buildExperimentReport`; `@hypdriv/flags` exports `evaluateExperiment`, the exposure sinks and `EXPERIMENTS_KEY`.

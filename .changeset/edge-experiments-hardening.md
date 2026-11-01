---
"@hypdriv/core": minor
"@hypdriv/flags": minor
"@hypdriv/runtime": minor
"@hypdriv/observe": minor
"@hypdriv/cache": minor
"@hypdriv/cloudflare": minor
"@hypdriv/vercel": patch
"@hypdriv/cli": minor
---

Edge experiments and smart warming, hardened after review.

Experiments: visitors are counted under `proxy.ts` too (the pass-through marker is recognised as a page); cache warm-ups, crawlers, preview fetchers and `hypdriv audit` are never assigned, counted or given a cookie; the audience (`experiment.when`, now validated: an unknown condition is an error) is checked before a stored assignment, so a withdrawn consent drops the visitor; a new `salt` restarts the experiment (the cookie remembers the salt that assigned each variant, `name:variant~generation`); an experiment the cookie cannot hold (a name outside `[A-Za-z0-9_-]{1,48}`, or more than 24 per visitor) is no longer counted on every page view; exposure rows carry the route pattern instead of the visited URL; Firefox `X-moz: prefetch` and `X-Purpose: preview` are not page views; an opened prerender is counted from its web-vitals beacon (`exposeActivatedPrerender`, `vitalsHandler({ onPrerenderActivation })`); inherited property names such as `toString` are no longer valid defaults or variants.

Cache: variant copies of experiment policies carry `Vary: Cookie`; `purgeUrls` deletes every experiment-variant, flag-value, locale and device copy by key, so it works with a shared store and per-isolate tag indexes (`enumerateVariantInputs`); warm-ups request each variant combination (`createWarmVariantPlanner`, at most 16 per page); the Vercel CDN stage no longer stores a response the flags stage may set the experiment cookie on.

Report: the sample ratio check uses an exact binomial test when a variant is expected to get fewer than 5 visitors (Bonferroni over more than two variants) instead of an over-flagging χ², names its method, and `hypdriv experiments --results --json` exits 1 on a mismatch like the text output; `--since` starts the window at a change of weights or traffic (a ramp reads as a mismatch otherwise); `days: NaN` can no longer reach the query text.

Warming: hot-page paths are canonicalised before they are judged (`%2e%2e`, `%5Fhypdriv` and other aliases of dot segments or internal paths are refused; aliases of one page count once); the Worker and `hypdriv warm --hot` fail closed when they cannot tell whether the cache keeps a page; `warm --hot` keeps the default static/ISR routes; the CLI marks its requests `x-hypdriv-warm`; the scheduled warm-up logs a warning without `site.origin`.

Doctor: `experiments.cache` is per policy and tells Vercel which pages its CDN cannot cache while an experiment runs; `experiments.static-pages` warns about experiments on pages the static layer serves before Hypdriv runs; `wrangler.crons` and `security.warm-hot` check that `cache.warm.cron` is a `triggers.crons` entry, and `security.warm-hot` that `site.origin` is set.

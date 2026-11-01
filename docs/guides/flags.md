# Edge feature flags

Flags are evaluated once per request at the edge (or in `proxy.ts`), before Next.js runs, and forwarded to the application as a header. They are deterministic per visitor (a stable id cookie `hyp_uid`), so percentage rollouts are sticky, and they can vary the edge cache (`vary.flags`).

```ts
flags: {
  definitions: {
    newCheckout: { default: false, rules: [{ when: { country: ['US', 'CA'] }, percentage: 25, value: true }] },
    pricingVariant: { default: 'a', rules: [{ percentage: 50, value: 'b' }] },
    maintenanceBanner: { default: false, rules: [{ when: { from: '2026-11-01T00:00:00Z', until: '2026-11-02T00:00:00Z' }, value: true }] },
    internal: { default: false, serverOnly: true, rules: [{ when: { cookie: { staff: '1' } }, value: true }] },
  },
  provider: 'static',              // or 'env' (JSON in HYPDRIV_FLAGS), 'kv' (HYPDRIV_KV key `flags`), 'openfeature'
  queryOverrides: 'development',   // ?hyp_flag_newCheckout=true in dev
}
```

Rule conditions: `country`, `continent`, `path` patterns, `cookie`/`header` equality, `device` (`mobile|desktop|bot`), `from`/`until` windows, `flag` dependencies. The first matching rule wins; `percentage` buckets by `hash(stableId, flagName)`.

## Reading flags

```ts
// server (components, actions, route handlers)
import { flag, hyp } from 'hypdriv/server';
const enabled = await flag('newCheckout', false);
const { flags } = await hyp();
```

```tsx
// client
import { FlagsProvider, useFlag } from 'hypdriv/client';
// in a server layout: <FlagsProvider values={publicFlags}>…</FlagsProvider>  (publicFlags = await hyp() then filter serverOnly)
const variant = useFlag('pricingVariant', 'a');
```

## Providers

- **static**: definitions from config (redeploy to change).
- **env**: `HYPDRIV_FLAGS='{"newCheckout":{"default":true}}'` merged over config; change with `wrangler secret put` or the dashboard, no redeploy.
- **kv**: JSON definitions under `flags` in `HYPDRIV_KV`, refreshed every `refresh` (30 s); edit with `wrangler kv key put`.
- **openfeature**: pass an OpenFeature client (for example Cloudflare's Flagship provider) to `createPlatform({ overrides: { flagsProvider: openFeatureProvider(client, definitions) } })`.

## Experiments (A/B tests)

Give a flag an `experiment` block and it becomes an A/B (or A/B/n) test that runs at the edge: assignment, stickiness, the cached copies and the visitor count all happen before the application renders.

```ts
flags: {
  definitions: {
    checkout: {
      default: 'control',                    // the control: what everyone outside the test sees
      experiment: {
        variants: { control: 50, one_page: 25, express: 25 },   // relative weights
        traffic: 80,                         // 80 % of the audience takes part; the rest see the control and are not counted
        when: { country: ['US', 'CA'] },     // audience: same conditions as a flag rule
        expose: ['/checkout/**'],            // count a visitor only when they view these paths (default: any page)
      },
    },
  },
}
```

Read the variant like any flag: `await flag('checkout', 'control')`, `useFlag('checkout', 'control')`, `getFlag` in a route handler.

How a visitor is assigned:

- **Deterministic.** The variant is a function of the stable visitor id (`hyp_uid`), the experiment name and `salt`, so every request, every colo and every Worker instance agrees without shared state.
- **Sticky.** The first assignment is kept in the `hyp_exp` cookie (first-party, `HttpOnly`, `SameSite=Lax`, 180 days, a few bytes per experiment). Changing `variants` (adding one, shifting weights) or `traffic` later moves new visitors only; nobody flips variant mid-test, which is what a ramp needs. A stored variant the experiment no longer defines is assigned again.
- **`salt` restarts the experiment.** The cookie remembers which `salt` assigned each variant (a short fingerprint after `~`), so a new `salt` voids every stored assignment: each visitor is assigned again by `hash(stableId, name, salt)` and counted again as a fresh visitor. Nothing else restarts a test; a changed `salt` also changes the split, so read the results with `--since` the moment you changed it ([Results](#results)).
- **The audience is checked first.** `when` is evaluated on every request, before a stored assignment. A visitor who stops matching (consent withdrawn, left the country) gets the control, is not counted and loses the experiment's entry in the cookie, so a cookie issued earlier cannot keep a visitor in a test they have left. `when` takes the conditions of a flag rule (`country`, `continent`, `path`, `cookie`, `header`, `device`, `from`, `until`, `flag`); an unknown condition (`cookies`, `contry`) is a configuration error, not a rule that never matches.
- **Only visitors take part.** Crawlers and link-preview fetchers (user agent, or the bot shield's verdict when `security.bots` is on), the owner's `hypdriv audit` tooling and cache warm-ups (`x-hypdriv-warm`) always get the control; they are not assigned, not given a cookie and not counted. A client can claim to be one of these, which only takes itself out of the experiment.
- **Counted once.** The first HTML (or RSC) page view of a member — not a prefetch or prerender (`Next-Router-Prefetch`, `Purpose`, `Sec-Purpose`, `X-moz`, `X-Purpose: preview`), not an API call, not a redirect — is an exposure, recorded once per visitor and experiment. The cookie is what remembers it, so a visitor is only counted when the cookie can hold the experiment: names are 1–48 letters, digits, `_` or `-` (a remote provider's `new.checkout` is assigned but never counted, with one warning per name), and the cookie holds 24 experiments per visitor (config validation warns above that).
- **QA overrides are never counted.** `?hyp_flag_checkout=express` (development, or `queryOverrides: true`) forces one of the experiment's own variants for that request; it is not stored and not counted. Unknown variants are ignored.

Lifecycle, with `status`:

| `status` | Visitors with a variant | New visitors |
| --- | --- | --- |
| `running` (default) | keep it | assigned by weight |
| `paused` | keep it | control, not counted |
| `concluded` | everyone gets `winner` (the control if none) | the same |

Roll out the winner by setting `status: 'concluded', winner: 'express'`; remove the block once the code ships.

### Exposures

Exposures go where `flags.exposures` says: `auto` (default) writes to Analytics Engine when `HYPDRIV_ANALYTICS` is bound and to the log otherwise, `log`, `analytics-engine`, or `none`. `flags.exposuresBinding` names a different binding. The log line is `experiment exposure` with `experiment`, `variant`, `pathname`, `route`, `country`; the Analytics Engine layout is documented in [Observability](observability.md#experiments). No visitor id is stored — counting rows counts visitors. `pathname` is the matched **route pattern** (`/orders/[id]`, `/blog/[slug]`), or `(unmatched)` when no route matched, never the raw URL: a path can carry a token (a reset link, an order id), and the log and the dataset outlive the request.

### Caching

Edge cache policies vary on **every running experiment by default** (`vary.experiments: true`), explicit and inferred policies alike: each variant is cached and served separately, so a cached page never shows one visitor another's variant. Set `vary: { experiments: false }` on a policy whose pages never depend on an experiment (assets, APIs) to keep one copy. `hypdriv doctor` (`experiments.cache`) counts the cached copies of the widest policy and warns when running experiments multiply them beyond 16; conclude finished experiments. Experiments defined only by a remote provider (KV, OpenFeature) are not known at build time: list them in `vary.flags`.

What the cache does with the variants:

- **Responses carry `Vary: Cookie`** when the policy varies on flags or experiments (next to `Cache-Control: public, s-maxage=…`), because the variant is decided from the visitor's cookies: a shared cache in front of the Worker must not hand one visitor's copy to another. The edge cache's own lookups use a synthetic request without cookies, so the header does not defeat Hypdriv's cache. The `hyp_uid` and `hyp_exp` cookies are added by the flags stage after the cache, so a cached copy never carries one visitor's `Set-Cookie`; a response that sets a cookie itself is not stored.
- **Warming fills every copy.** `hypdriv warm`, the `cache.warm.cron` job and hot-page warming request each page once per combination of the running experiments its policy varies on (the control combination first, at most 16 requests per page), marked `x-hypdriv-warm` and carrying a cookie that names the variants. Warm-ups are not assigned, counted or given a cookie.
- **A URL purge reaches every copy.** `purgeEdge({ urls })` and `hypdriv purge --path` delete the base key and the key of every experiment variant, flag value, locale and device class the configuration knows (up to 64 combinations per URL), without needing a tag index shared between isolates; beyond that they fall back to the `path:` tag.
- **Vercel cannot hold one copy per variant.** Vercel's CDN keys a cached response by URL and `Vary` request headers only, and `Vary: Cookie` makes a response uncacheable there. While an experiment runs, Hypdriv therefore leaves every Vercel policy that varies on it uncached (cache status `BYPASS`, reason `vary:flags`, one warning per policy) instead of risking a copy that shows one visitor another's variant. `hypdriv doctor` (`experiments.cache`) names the affected policies. Set `vary.experiments: false` on policies whose pages do not depend on the experiment (statically rendered pages cannot read a per-visitor variant at all), or conclude the experiment. The same holds for the experiment cookie itself: a response the flags stage may set a cookie on is not CDN-cached.
- **Pages the platform serves as static files never reach Hypdriv.** A prerendered document that Workers Static Assets, the Vercel CDN or `hypdriv serve` answers (a route with `servedStatically` in the manifest) is returned before the Worker runs, so nothing is assigned, set or counted on it. `hypdriv doctor` (`experiments.static-pages`) lists those pages and warns when an experiment's `expose` names one. Render the page on demand if it should take part.

### Results

```sh
hypdriv experiments                                                  # what is configured
CF_ACCOUNT_ID=… CF_API_TOKEN=… hypdriv experiments --results --days 14   # visitors and p75 LCP/INP/CLS per variant
hypdriv experiments --results --name checkout --since 2026-10-30T14:00:00Z   # from the moment the weights changed
hypdriv experiments --results --name checkout --sql                  # the Analytics Engine SQL, no credentials needed
```

The report shows the visitors each variant received against the configured weights and p75 LCP, INP and CLS per variant with the change against the control. It also runs a **sample ratio check** against the weights, flagged below p = 0.001: a split that differs from the weights by more than chance explains means the assignment or the counting is broken — a redirect that drops one variant, a cache that ignores the variant, bots — and nothing else in the report can be trusted until it is fixed. `hypdriv experiments --results` exits `1` on a mismatch, with or without `--json`, so it works in CI. Business metrics (conversions, revenue) stay in your analytics: join them on the `experiment:variant` the application already knows through the flag.

Two things about the check:

- **The test fits the numbers.** With every variant expected to get at least 5 visitors it is Pearson's χ². Below that (a 99/1 split with a few hundred visitors) χ² over-flags — 95 of 100 against 99/1 gives p = 0.00006 by χ² but 0.0034 exactly — so an exact two-sided binomial test decides, and with more than two variants the smallest per-variant p is multiplied by the number of variants. The report names the test (`method`: `chi-square` or `exact`).
- **It compares the window with the weights as they are now.** Visitors keep their variant when weights or `traffic` change (a ramp), so a window that spans a change legitimately differs from the current split and reads as a mismatch. Start the window at the change with `--since` (an ISO date or timestamp, UTC, or a duration back from now such as `36h` or `3d`; at most 90 days) instead of `--days`, or restart the experiment with a new `salt`. The Analytics Engine query uses `timestamp >= toDateTime('…')`; `--since` replaces `--days`.

### What is and is not protected

Experiments run on a public edge, so the edges of the measurement are worth knowing:

- **Cannot be forged:** a variant outside the definition (a forged `hyp_exp` or `?hyp_flag_` falls back to the control), a client-supplied `x-hypdriv-*` header (stripped before the stages run; `x-hypdriv-warm` is the one claim that takes a client out of the test), the experiment tag of a vitals beacon (read from the cookie, never from the body), and oversized or malformed experiment names (rejected at the cookie codec, bounded at 24 per visitor and 1800 bytes).
- **Can be skewed by a determined client:** visitor counts and per-variant vitals. A client that sets its own `hyp_uid`, clears its cookies or replays the unauthenticated beacon can add exposures or vitals rows to the variant it picks. The beacon is bounded (64 KiB, sampled with `observe.vitals.sampleRate`, CORS limited to `site.origin`), exposures are one per cookie and experiment, and crawlers and the audit tooling are excluded, but nothing proves a visitor is human. Put a `security.rateLimit` rule on page routes and on the vitals endpoint and turn on `security.bots` when the numbers matter; treat the report as the measurement of a cooperative audience, and decide on business metrics from your own analytics.
- **Prefetched and prerendered pages.** A page the browser fetches speculatively (Speculation Rules `prefetch` or `prerender`, `Sec-Purpose`, `Purpose`, Next.js route prefetches) is not an exposure when it is fetched: the visitor may never open it. Opening a **prerendered** page sends no further request, so its web-vitals beacon (`navigationType: 'prerender'`) counts the exposure instead, for the experiments the visitor was assigned to whose `expose` paths match the opened page, and marks them counted in the cookie (needs `observe.vitals` and `<VitalsReporter />`). Opening a page that was only **prefetched** is not visible to the Worker or the beacon, so the visitor is counted on their next real request; one who leaves straight after such a landing is not counted. Neither variant is favoured unless a variant changes the bounce rate; keep the pages of an `expose` list out of `prefetch` rules when exact counts matter (`performance.speculation` injects both kinds: `prerender` for the top links, `prefetch` for the rest).
- **Cookie lifetime.** `hyp_exp` lasts 180 days from its last write and `hyp_uid` one year; the report window is at most 90 days, so a visitor is not counted twice within it. An experiment that runs for more than 180 days assigns long-gone visitors again (by the same hash, so mostly to the same variant) and counts them again.

### Privacy

The experiment cookie is a first-party cookie like `hyp_uid`: it holds experiment names and variant names, no visitor identifier leaves your infrastructure and exposures carry no id. Whether a cookie like this needs consent depends on where your visitors are (in the EU/EEA the ePrivacy rules apply to it; US state laws differ) and is a question for your counsel, not a Hypdriv setting. If your policy requires consent first, serve the control until it is given with an audience rule on your consent cookie: `experiment: { …, when: { cookie: { consent: '1' } } }`.

## Caching and flags

Add `vary: { flags: ['newCheckout'] }` to edge cache policies for routes whose HTML depends on a flag; Hypdriv then keys the cache per flag value. Flags that only affect client components do not need it. Experiments are the exception: policies vary on running experiments automatically (see [Experiments](#caching)).

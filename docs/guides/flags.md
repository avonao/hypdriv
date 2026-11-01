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

- **Deterministic.** The variant is a function of the stable visitor id (`hyp_uid`), the experiment name and `salt`, so every request, every colo and every Worker instance agrees without shared state. Change `salt` to restart the test with a fresh split.
- **Sticky.** The first assignment is kept in the `hyp_exp` cookie (first-party, `HttpOnly`, `SameSite=Lax`, 180 days, a few bytes per experiment). Changing weights, traffic or the audience later moves new visitors only; nobody flips variant mid-test.
- **Counted once.** The first HTML (or RSC) page view of a member — not a prefetch, not an API call, not a redirect — is an exposure, recorded once per visitor and experiment.
- **QA overrides are never counted.** `?hyp_flag_checkout=express` (development, or `queryOverrides: true`) forces one of the experiment's own variants for that request; it is not stored and not counted. Unknown variants are ignored.

Lifecycle, with `status`:

| `status` | Visitors with a variant | New visitors |
| --- | --- | --- |
| `running` (default) | keep it | assigned by weight |
| `paused` | keep it | control, not counted |
| `concluded` | everyone gets `winner` (the control if none) | the same |

Roll out the winner by setting `status: 'concluded', winner: 'express'`; remove the block once the code ships.

### Exposures

Exposures go where `flags.exposures` says: `auto` (default) writes to Analytics Engine when `HYPDRIV_ANALYTICS` is bound and to the log otherwise, `log`, `analytics-engine`, or `none`. `flags.exposuresBinding` names a different binding. The log line is `experiment exposure` with `experiment`, `variant`, `pathname`, `route`, `country`; the Analytics Engine layout is documented in [Observability](observability.md#experiments). No visitor id is stored — counting rows counts visitors.

### Caching

Edge cache policies vary on **every running experiment by default** (`vary.experiments: true`), explicit and inferred policies alike: each variant is cached and served separately, so a cached page never shows one visitor another's variant. Set `vary: { experiments: false }` on a policy whose pages never depend on an experiment (assets, APIs) to keep one copy. `hypdriv doctor` (`experiments.cache`) counts the cached copies per page and warns when running experiments multiply them beyond 16; conclude finished experiments. Experiments defined only by a remote provider (KV, OpenFeature) are not known at build time: list them in `vary.flags`.

### Results

```sh
hypdriv experiments                                                  # what is configured
CF_ACCOUNT_ID=… CF_API_TOKEN=… hypdriv experiments --results --days 14   # visitors and p75 LCP/INP/CLS per variant
hypdriv experiments --results --name checkout --sql                  # the Analytics Engine SQL, no credentials needed
```

The report shows the visitors each variant received against the configured weights and p75 LCP, INP and CLS per variant with the change against the control. It also runs a **sample ratio check** (χ² against the weights, flagged below p = 0.001): a split that differs from the weights by more than chance explains means the assignment or the counting is broken — a redirect that drops one variant, a cache that ignores the variant, bots — and nothing else in the report can be trusted until it is fixed. `hypdriv experiments --results` exits `1` on a mismatch, so it works in CI. Business metrics (conversions, revenue) stay in your analytics: join them on the `experiment:variant` the application already knows through the flag.

### Privacy

The experiment cookie is a first-party cookie like `hyp_uid`: it holds experiment names and variant names, no visitor identifier leaves your infrastructure and exposures carry no id. Whether a cookie like this needs consent depends on where your visitors are (in the EU/EEA the ePrivacy rules apply to it; US state laws differ) and is a question for your counsel, not a Hypdriv setting. If your policy requires consent first, serve the control until it is given with an audience rule on your consent cookie: `experiment: { …, when: { cookie: { consent: '1' } } }`.

## Caching and flags

Add `vary: { flags: ['newCheckout'] }` to edge cache policies for routes whose HTML depends on a flag; Hypdriv then keys the cache per flag value. Flags that only affect client components do not need it. Experiments are the exception: policies vary on running experiments automatically (see [Experiments](#caching)).

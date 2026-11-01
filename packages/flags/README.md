# @hypdriv/flags

Edge feature flags for [Hypdriv](https://github.com/avonao/hypdriv): deterministic percentage rollouts, geo / path / cookie / header / device / date-window rules, flag dependencies, QA overrides, pluggable providers (static, env, KV, OpenFeature) and React hooks. Flags are evaluated once per request at the edge (Worker or `proxy.ts`), forwarded to Next.js in a header and exposed to server and client code.

Zero infrastructure: the static and env providers need nothing. KV and OpenFeature are optional upgrades.

## Install

```sh
pnpm add @hypdriv/flags @hypdriv/core
```

`react` is an optional peer, needed only for `@hypdriv/flags/react`.

## Define flags

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  flags: {
    definitions: {
      'new-checkout': {
        description: 'Rewritten checkout flow',
        default: false,
        rules: [
          { when: { cookie: { tier: ['gold', 'platinum'] } }, value: true }, // VIPs always
          { when: { country: ['US', 'CA'] }, percentage: 25, value: true }, // 25 % of North America
        ],
      },
      'hero-variant': {
        default: 'a',
        rules: [
          { when: { path: ['/pricing', '/pricing/**'], device: 'mobile' }, value: 'compact' },
          { when: { from: '2026-11-27T00:00:00Z', until: '2026-11-30T00:00:00Z' }, value: 'sale' },
          { percentage: 50, value: 'b' },
        ],
      },
      'checkout-upsell': {
        default: false,
        rules: [{ when: { flag: { 'new-checkout': true } }, value: true }], // depends on another flag
      },
      'internal-pricing': { default: 'list', serverOnly: true }, // never sent to the browser
    },
    provider: 'static', // 'env' | 'kv' | 'openfeature'
    queryOverrides: 'development', // ?hyp_flag_new-checkout=true
  },
});
```

Evaluation order per flag: **override → first matching rule → default**. A rule matches when every `when` condition holds; when `percentage` is set the visitor must also fall into the bucket, which is `bucketPercent(stableId, flagName) < percentage` — stable per visitor, independent across flags, and monotonic (raising 25 % to 40 % keeps everyone who was already in). Circular `when.flag` dependencies never match.

## The stage

```ts
import { createFlagProvider, flagsStage } from '@hypdriv/flags';

const provider = createFlagProvider(config, env); // picks config.flags.provider
const stage = flagsStage(config, provider); // name: 'flags'
```

Per request the stage:

1. reads the stable id from the `hyp_uid` cookie (`flags.idCookie`); when it is missing and a definition needs it (percentage rules, OpenFeature targeting) it generates one with `randomToken(12)` and sets the cookie **once** in `post` (`Max-Age` 1 year, `Path=/`, `SameSite=Lax`, `HttpOnly`, `Secure` on https);
2. evaluates every definition with geo from `request.cf`, the device class (`sec-ch-ua-mobile`, then user agent) and `?hyp_flag_<name>=` overrides when `queryOverrides` is `true` or (`'development'` and the runner is in development);
3. stores `FLAGS_KEY`, `FLAG_REASONS_KEY` and `FLAG_ID_KEY` in `ctx.state`;
4. forwards **all** values to Next.js in `x-hypdriv-flags` (`flags.header`) as base64url JSON. An incoming header with that name is always replaced, so clients cannot inject flags; when no flags are defined the header is removed;
5. annotates the `flags` Server-Timing entry with the number of flags (`flags;dur=0.3;desc="3"`).

The stage does not add `Vary: Cookie`. Declare `vary.flags: ['hero-variant']` on edge-cache policies whose HTML depends on a flag; the cache stage reads `FLAGS_KEY`.

## Reading flags

On the server (`@hypdriv/next` wraps this in `hyp().flags` / `flag()`):

```ts
import { flagsFromHeaders, publicFlags } from '@hypdriv/flags';
import { headers } from 'next/headers';

const flags = flagsFromHeaders(await headers()); // { 'new-checkout': true, ... }
const forClient = publicFlags(flags, definitions); // strips serverOnly flags
```

In client components:

```tsx
'use client';
import { Flag, FlagsProvider, useFlag } from '@hypdriv/flags/react';

export function Providers({ flags, children }) {
  return <FlagsProvider values={flags}>{children}</FlagsProvider>;
}

export function Checkout() {
  const variant = useFlag('hero-variant', 'a');
  return (
    <>
      <Flag name="new-checkout" fallback={<LegacyCheckout />}>
        <NewCheckout />
      </Flag>
      <Flag name="hero-variant" value="sale">
        <SaleBanner />
      </Flag>
      <p>variant {variant}</p>
    </>
  );
}
```

Hooks are SSR-safe (no `window` access) and return the fallback outside a provider.

## Experiments

A flag with an `experiment` block is an A/B test: weighted variants, deterministic and sticky assignment (the `hyp_exp` cookie), an audience (`when`), a traffic share, `status: 'running' | 'paused' | 'concluded'` with a `winner`, and exposures reported once per visitor.

```ts
definitions: {
  checkout: {
    default: 'control',
    experiment: { variants: { control: 50, express: 50 }, traffic: 80, when: { country: ['US'] }, expose: ['/checkout/**'] },
  },
}
```

- `evaluateExperiment(name, def, spec, { stableId, memberships, inAudience })` is the pure assignment (`{ variant, reason, member }`); `pickVariant(variants, bucket)` and `hasVariant(spec, v)` are its parts.
- `flagsStage(config, provider, { onExposure })` reports exposures to an `ExposureSink`: `analyticsEngineExposureSink(binding)`, `logExposureSink(log)`, `multiExposureSink(sinks)`; `createHandler()` picks one from `flags.exposures`.
- `EXPERIMENTS_KEY` holds the per-request outcomes in `ctx.state` for other stages.
- `?hyp_flag_<name>=<variant>` forces one of the experiment's own variants for QA, uncounted and unstored.

Read the result with `hypdriv experiments --results`. Full guide: [docs/guides/flags.md](../../docs/guides/flags.md#experiments-ab-tests).

## Providers

| Provider | Source | Refresh | Notes |
| --- | --- | --- | --- |
| `staticProvider(defs)` | config | — | default |
| `envProvider(env, 'HYPDRIV_FLAGS', defs)` | JSON in an env var / secret, merged over config | when the value changes | invalid JSON → config definitions + one warning |
| `kvProvider(kv, 'flags', defs, refreshSeconds)` | JSON object in KV | every `flags.refresh` (default 30 s) per isolate, coalesced | missing key or read error → last good value or config |
| `openFeatureProvider(client, defs)` | any OpenFeature client | — | evaluates remotely (`getBooleanValue` / `getStringValue` / `getNumberValue` by the default's type) with `{ targetingKey, country, continent, path, device }`; local overrides still win; a throwing client falls back to local rules |

Remote JSON is validated: definitions without a boolean, string or number `default` are dropped with a warning, so a typo in KV cannot break requests.

`createFlagProvider(config, env, { openFeatureClient?, log? })` picks the provider from `config.flags.provider` and degrades to static definitions when the KV binding or the OpenFeature client is missing.

## Pure evaluation

```ts
import { evaluateFlags } from '@hypdriv/flags';

const { values, reasons } = evaluateFlags({
  definitions,
  stableId: 'visitor-123',
  url: new URL('https://shop.example.com/pricing'),
  headers: new Headers(),
  cookies: { tier: 'gold' },
  geo: { country: 'US', continent: 'NA' },
  device: 'desktop',
  now: new Date(),
  overrides: { 'hero-variant': 'b' },
});
// reasons: { 'new-checkout': 'rule:0', 'hero-variant': 'override', 'checkout-upsell': 'rule:0', ... }
```

Reasons are `default`, `rule:<index>`, `override`, `percentage-miss:<index>` (a rule's conditions matched but the visitor fell outside the percentage), `openfeature` or `openfeature-error`.

## Encoding

`encodeFlagsHeader(values)` produces base64url JSON with sorted keys (stable for cache keys); `decodeFlagsHeader(value)` tolerates raw JSON, standard base64 and garbage (returns `{}`). The same encoding is used for the `<meta name="hypdriv:flags">` tag that the DevTools HUD reads.

## API

- `evaluateFlags(input)`, `evaluateFlag(name, input)`, `publicFlags(values, definitions)`, `parseQueryOverrides(url, definitions)`, `coerceFlagValue(raw, type)`, `flagType(definition)`, `needsStableId(definitions)`
- `staticProvider`, `envProvider`, `kvProvider`, `openFeatureProvider`, `createFlagProvider`, `parseFlagDefinitions`
- `flagsStage(config, provider, { now? })`, `detectDevice(headers)`, `FLAGS_KEY`, `FLAG_REASONS_KEY`, `FLAG_ID_KEY`
- `encodeFlagsHeader`, `decodeFlagsHeader`, `flagsFromHeaders`, `isFlagValue`, `sanitizeFlagValues`
- `@hypdriv/flags/react`: `FlagsProvider`, `useFlags`, `useFlag`, `Flag`

## License

MIT

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

## Caching and flags

Add `vary: { flags: ['newCheckout'] }` to edge cache policies for routes whose HTML depends on a flag; Hypdriv then keys the cache per flag value. Flags that only affect client components do not need it.

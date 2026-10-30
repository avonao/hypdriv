---
"@hypdriv/flags": minor
"@hypdriv/live": minor
"@hypdriv/image": minor
"@hypdriv/devtools": minor
"@hypdriv/testing": minor
---

Initial implementations of five sidecar packages:

- `@hypdriv/flags`: deterministic edge feature flags (`evaluateFlags`, static/env/KV/OpenFeature providers, the `flags` stage with a once-set `hyp_uid` cookie and `x-hypdriv-flags` propagation, React `FlagsProvider`/`useFlag`/`<Flag>`).
- `@hypdriv/live`: the `HypDrivChannel` Durable Object (SQLite replay, WebSocket hibernation, SSE), `createLiveHandler`, server-side `publish()` with a polling fallback, and the `useLive`/`useLiveValue`/`useLiveRefresh` hooks.
- `@hypdriv/image`: Cloudflare `/cdn-cgi/image` loader for `next/image`, `createHypImage` with blur placeholders, and `generatePlaceholders` (sharp optional).
- `@hypdriv/devtools`: the in-app HUD reading Server-Timing, Web Vitals, RSC navigations, flags, Purser diagnostics, build info and capabilities.
- `@hypdriv/testing`: fake KV/Cache/Durable Object/Queue/Analytics Engine/ExecutionContext/Rate Limit bindings, a controllable clock, the `createTestContext`/`runStage` harness and vitest presets.

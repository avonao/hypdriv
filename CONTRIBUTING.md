# Contributing to HypDriv

Thanks for helping make Next.js and Vite-based applications on Cloudflare Workers, Vercel and Node faster, safer and more observable. HypDriv is in Preview (0.1.0); issues and pull requests are welcome.

## Ground rules

- **Production posture.** Every feature is built to its complete, production-grade form. We do not land stubs, "MVP" paths or TODO-driven partial implementations. If a feature needs a new subsystem, build the subsystem.
- **Sidecar only.** HypDriv never forks or patches Next.js, OpenNext, Vite or a framework. It integrates through public contracts: `next.config.ts`, the Adapter API, `proxy.ts`, Vite plugins and framework integrations, the Worker entry, and application code.
- **Zero-infrastructure baseline.** Everything must work on a bare Worker with the static-assets binding that OpenNext already requires. Bindings (KV, R2, D1, Durable Objects, Queues, Rate Limiting, Analytics Engine, Images) only _upgrade_ behaviour and are always optional and auto-detected.
- **Purser stays untouched.** The `@hypdriv/purser` bridge consumes Purser's public build API; we never modify Purser from this repository.

## Development

```sh
pnpm install
pnpm build          # build every package (tsdown)
pnpm test           # vitest, Node + Workers runtime projects
pnpm typecheck      # tsc --noEmit per package
pnpm lint           # biome
```

Node 20.9+ and pnpm 10+ are required (`corepack enable` picks the pinned pnpm).

Workspace packages resolve each other through the `source` export condition, so tests and type checks run against `src/` without a prior build. Published consumers get `dist/`.

### Layout

```
packages/core        runtime-agnostic kernel: config, pipeline, manifest, utils
packages/runtime     framework-neutral stages, platform wiring and request handler
packages/build       framework-neutral manifest assembly and static header rules
packages/vite        Vite plugin and the toolkit behind the framework integrations
packages/react-router, tanstack-start, astro, sveltekit, nuxt, vinext   one integration per framework
packages/vercel      Vercel CDN headers and purge, Upstash/Global Config stores, WAF, BotID, Queues
packages/next        Next.js integration: withHypDriv, adapter chain, proxy composables, server/client helpers
packages/cloudflare  Worker shell around OpenNext, extra handlers, Durable Objects, bindings
packages/cache       edge cache engine
packages/security    CSP, headers, rate limiting, bot shield, safe actions, sessions, crypto helpers
packages/observe     tracing, logging, Server-Timing, Web Vitals
packages/purser      Purser CSS bridge
packages/flags       edge feature flags
packages/live        live channels (Durable Objects + SSE/WebSocket)
packages/image       Cloudflare image loader + placeholders
packages/devtools    in-app HUD
packages/testing     fakes and vitest presets
packages/cli         the `hypdriv` command
packages/create-hypdriv  project scaffolder
packages/hypdriv     umbrella package
```

### Tests

- Unit tests live next to the code as `*.test.ts`.
- Packages that touch Workers APIs (Cache API, Durable Objects, bindings) also have `*.workers.test.ts` files that run inside `workerd` through `@cloudflare/vitest-pool-workers`.
- Behaviour that is cheap to prove exhaustively (cache key normalisation, CSP serialisation, header merging, rate-limit windows) gets property-style tests.

### Pull requests

1. `pnpm lint && pnpm typecheck && pnpm build && pnpm test` pass locally.
2. Add a changeset (`pnpm changeset`) for any user-visible change. Use `patch` for fixes, `minor` for features, `major` for breaking changes.
3. Document new options in the relevant guide under `docs/guides/` and in the package README.
4. Keep commits in the form `<type>: <imperative summary>` (`feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `chore`).

### Security-sensitive changes

Changes to `packages/security` and to the CSP/headers stages need a second maintainer review and a test that demonstrates the attack the change prevents (or the regression it avoids).

## Licence

By contributing you agree that your contributions are licensed under the MIT licence of this repository.

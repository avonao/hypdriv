# HypDriv — guidance for coding agents

HypDriv is the Hyper-Extension for Next.js 16+ on Cloudflare Workers and Vercel: a sidecar monorepo of `@hypdriv/*` packages plus the `hypdriv` CLI. Read `docs/architecture.md` before changing anything structural; it is the source of truth. `docs/feature-catalog.md` lists every capability and its status; `docs/adr/` records the decisions behind the design.

## Posture

- **Production grade, complete features.** Do not land stubs, TODO-only paths, "MVP" shortcuts or deferred large tasks. If a feature needs a new subsystem, build it in the same change.
- **Sidecar only.** Never patch `next`, `@opennextjs/*` or `wrangler`. Integrate through `next.config.ts`, the Adapter API, `proxy.ts`, the Worker entry and application code.
- **Zero-infrastructure baseline.** Every feature works on a bare Worker and on a plain Vercel project; bindings and platform services are optional upgrades detected at run time.
- **Two first-class platforms.** Cloudflare Workers and Vercel (`docs/adr/0013-deploy-targets.md`). Platform differences live in `packages/cloudflare`, `packages/vercel` and `detectDeployTarget()`; stages stay shared.
- **Purser is external.** `packages/purser` consumes `@avonao/purser/build`; never edit Purser from here.
- **US-first defaults.** Documentation examples use US regions/entities first; EU is a secondary market.

## Commands

```sh
pnpm install
pnpm build              # tsdown for every package
pnpm test               # vitest (Node + Workers projects)
pnpm typecheck          # tsc --noEmit per package
pnpm lint               # biome check
pnpm -F @hypdriv/<pkg> build|test|typecheck   # one package
pnpm changeset          # for user-visible changes
```

Workspace packages resolve through the `source` export condition, so tests and type checks run against `src/` without building first. Published consumers get `dist/`.

## Layout

```
packages/core        kernel: config schema, pipeline, manifest types + matcher, utils
packages/next        withHypDriv, adapter chain, proxy composables, server/client helpers
packages/cloudflare  Worker shell (createWorker), handlers, Durable Objects, bindings
packages/vercel      Vercel CDN headers + purge, Upstash/Global Config stores, WAF, BotID, Queues
packages/cache       edge cache engine (policies, keys, stores, SWR, tags)
packages/security    CSP, headers, rate limiting, bot shield, safeAction, sessions, crypto
packages/observe     tracing, logging, Server-Timing, Web Vitals
packages/purser      Purser bridge (build/watch, verification, themes, audit)
packages/flags       edge feature flags
packages/live        live channels (DO + SSE/WS + hooks)
packages/image       Cloudflare image loader + placeholders
packages/devtools    in-app HUD
packages/testing     fakes, request builders, vitest presets
packages/cli         the `hypdriv` command
packages/create-hypdriv  scaffolder
packages/hypdriv     umbrella
examples/            runnable Next 16 apps: basic, with-purser (Cloudflare); vercel, vercel-purser (Vercel); the create-hypdriv templates
docs/                architecture, catalog, ADRs, guides
skills/hypdriv       agent skill for adopting HypDriv in an application
```

## Conventions

- Strict TypeScript, ESM only, extensionless relative imports inside a package (bundler resolution), `.js`-free.
- Runtime packages must not import Node built-ins outside `/node` entry points; Workers-specific types come from `@cloudflare/workers-types` and only `packages/cloudflare`, `packages/live` and `packages/testing` may reference them.
- Tests: `*.test.ts` next to the code; Workers-runtime tests as `*.workers.test.ts` (run by `@cloudflare/vitest-pool-workers`).
- Public API changes need: tests, README/guide updates, a changeset, and an entry in `docs/feature-catalog.md`.
- Every CLI command supports `--json` and `--root`.
- Never log or persist secrets; redact with `redact()` from `@hypdriv/observe`.

## Verifying a change end to end

1. `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
2. For runtime behaviour: `pnpm -F @hypdriv/example-basic build:worker && pnpm -F @hypdriv/example-basic preview`, then `pnpm -F @hypdriv/cli exec hypdriv audit all --url http://localhost:8787`.
3. For Purser behaviour: `pnpm -F @hypdriv/example-with-purser audit:css`.
4. For Vercel behaviour: `VERCEL=1 pnpm -F @hypdriv/example-vercel build`, `pnpm -F @hypdriv/example-vercel start`, then `hypdriv audit all --url http://localhost:3000`; `vercel build` in `examples/vercel` checks the Build Output API.

## Dependency freshness

`hypdriv deps` (also run daily by `.github/workflows/dependencies.yml`) reports outdated packages across the workspace. Apply patch/minor updates automatically; report majors with a migration proposal before applying.

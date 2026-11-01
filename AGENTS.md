# Hypdriv — guidance for coding agents

Hypdriv is the Hyper-Extension for Next.js 16+ and Vite-based frameworks (plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext, Waku) on Cloudflare Workers, Vercel and Node: a sidecar monorepo of `@hypdriv/*` packages plus the `hypdriv` CLI. Read `docs/architecture.md` before changing anything structural; it is the source of truth. `docs/feature-catalog.md` lists every capability and its status; `docs/adr/` records the decisions behind the design.

## Posture

- **Production grade, complete features.** Do not land stubs, TODO-only paths, "MVP" shortcuts or deferred large tasks. If a feature needs a new subsystem, build it in the same change.
- **Sidecar only.** Never patch `next`, `@opennextjs/*`, `wrangler`, Vite or a framework. Integrate through their documented extension points: `next.config.ts`, the Adapter API, `proxy.ts`, Vite plugins, framework adapters/integrations/modules, request hooks, the Worker entry and application code (ADR 0019 for Vite hosts).
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
packages/runtime     framework-neutral stages, platform wiring, createHandler (hosts), createProxyHandler, hyp()
packages/build       framework-neutral manifest assembly + static header rules (_headers, Build Output routes)
packages/vite        Vite plugin for plain Vite apps + the toolkit every Vite framework integration uses
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
examples/            runnable Next 16 apps: basic, with-purser (Cloudflare); vercel, vercel-purser (Vercel); the create-hypdriv templates;
                     one app per Vite host (vite, …) that builds for Cloudflare, Vercel and Node
e2e/cloudflare       live suite: an app with every capability on + a runner that verifies it on a real Cloudflare account
e2e/vercel           live suite for Vercel (Hobby plan): app + runner (runtime-logs stream) + provisioning script
e2e/hosts            live checks for every Vite host example on Cloudflare, Vercel or Node + private-deployment provisioning
scripts/             repo tooling (tsdown 'use client' boundary plugin, size/deps reports)
docs/                architecture, catalog, ADRs, guides
skills/hypdriv       agent skill for adopting Hypdriv in an application
```

## Conventions

- Strict TypeScript, ESM only, extensionless relative imports inside a package (bundler resolution), `.js`-free.
- Runtime packages must not import Node built-ins outside `/node` entry points (`@hypdriv/build` and the Vite plugin entries are build-time Node code; `@hypdriv/runtime` loads `node:async_hooks` lazily); Workers-specific types come from `@cloudflare/workers-types` and only `packages/cloudflare`, `packages/live` and `packages/testing` may reference them.
- Tests: `*.test.ts` next to the code; Workers-runtime tests as `*.workers.test.ts` (run by `@cloudflare/vitest-pool-workers`).
- Public API changes need: tests, README/guide updates, a changeset, and an entry in `docs/feature-catalog.md`.
- Every CLI command supports `--json` and `--root`.
- Never log or persist secrets; redact with `redact()` from `@hypdriv/observe`.

## Verifying a change end to end

1. `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
2. For runtime behaviour: `pnpm -F @hypdriv/example-basic build:worker && pnpm -F @hypdriv/example-basic preview`, then `pnpm -F @hypdriv/cli exec hypdriv audit all --url http://localhost:8787`.
3. For Purser behaviour: `pnpm -F @hypdriv/example-with-purser audit:css`.
4. For Vercel behaviour: `VERCEL=1 pnpm -F @hypdriv/example-vercel build`, `pnpm -F @hypdriv/example-vercel start`, then `hypdriv audit all --url http://localhost:3000`; `vercel build` in `examples/vercel` checks the Build Output API.
5. For behaviour only production shows (colos, zone purges, Queues, cron, Analytics Engine, Early Hints, Turnstile): deploy `e2e/cloudflare` to a Cloudflare account and run `pnpm -F @hypdriv/e2e-cloudflare e2e` (see its README). Keep account-specific configuration in git-ignored `wrangler.*.local.jsonc` files.
6. For Vite hosts: build the host example for each target (`HYPDRIV_TARGET=cloudflare|vercel|node`), `vite preview` / `hypdriv serve`, then `pnpm -F @hypdriv/e2e-hosts check --url … --framework <name> …` and `hypdriv audit all`; on real accounts deploy privately with `pnpm -F @hypdriv/e2e-hosts provision` (see its README).
7. For behaviour only a Vercel deployment shows (Routing Middleware vs Functions, CDN tag purge, ISR, Global Config, Vercel Queues, Cron, WAF, BotID): `pnpm -F @hypdriv/e2e-vercel provision …`, deploy prebuilt from the repository root, then `pnpm -F @hypdriv/e2e-vercel e2e` (see its README). Never put an account token into a deployment's environment.

## Putting Hypdriv into a production Cloudflare setup

`docs/guides/production-cloudflare.md` is the implementation guide for applications and platforms that go live on Cloudflare: install from a release bundle, the OpenNext production cache (populate the R2 cache before the first request), the policy, Cloudflare resources and secrets, fleets of area Workers behind a router, first-deploy probes, the launch checklist and troubleshooting. Follow it step by step and record the evidence its checklist asks for.

## Pitfalls the live runs found

- Never `await response.body.cancel()` in code that can run inside Next.js: Next tees `fetch` bodies and the cancel never settles (`void res.body?.cancel().catch(() => undefined)`).
- On Vercel, Routing Middleware and Functions are separate invocations: anything `createProxy` registers is invisible to Route Handlers and Server Actions unless `createInstrumentation().register()` registers it too.
- A prerender with explicit cache tags changes after `revalidateTag()`; it is `isr`, never hash-CSP `static` (ADR 0018).
- Anything a runner answers before the pipeline (internal routes, static assets) must respect `forceHttps` itself — call `httpsUpgrade()` first.
- Workers Static Assets answer before the Worker, so `forceHttps` never sees plain-HTTP asset requests: gated test zones carry a Redirect Rule for their hosts, and `hypdriv audit https` checks pages, internal routes and a hashed asset over `http://`.
- The runners strip every client-supplied `x-hypdriv-*` header before the stages run. The one internal route that reads such a header, `POST /_hypdriv/purge` (`x-hypdriv-purge`), gets it from `info.purgeToken`, which each runner fills from the original request. A new header-authenticated internal route needs the same hand-over.
- A raw Cloudflare tag purge clears only the Cache API tier; Hypdriv's store is memory → Cache API → KV with backfill from lower tiers. Operator purges go through `hypdriv purge` (the Worker's own `purgeTags`), never the zone API alone.
- Egress from CI and agent sandboxes can rotate client addresses per connection: verify IP-keyed rate limits over one keep-alive connection.
- Test deployments are private: Vercel Authentication on all deployments + automation bypass; on Cloudflare a gated custom domain (`provision --gate`) with `workers.dev` off. Tooling passes gateways with `VERCEL_AUTOMATION_BYPASS_SECRET`, `CF_ACCESS_CLIENT_ID/_SECRET` or `HYPDRIV_ACCESS_HEADERS`.

## Dependency freshness

`hypdriv deps` (also run daily by `.github/workflows/dependencies.yml`) reports outdated packages across the workspace. Apply patch/minor updates automatically; report majors with a migration proposal before applying. Open majors and their trial results: `docs/dependency-majors.md`.

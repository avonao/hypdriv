# Hypdriv Preview — status

_Release: 0.1.0 (Preview) · verified 2026-10-31_

Hypdriv 0.1.0 is a Preview release. Every capability in [`feature-catalog.md`](feature-catalog.md) is implemented in this repository and exercised by the test suites and the live runs below. APIs, configuration keys and the manifest format can still change before 1.0 (see [`roadmap.md`](roadmap.md)).

## Components

| Component | Packages | Status |
| --- | --- | --- |
| Core: configuration schema, Drivetrain pipeline, manifest | `@hypdriv/core`, `@hypdriv/build`, `@hypdriv/runtime` | Preview |
| Next.js 16+ integration | `@hypdriv/next`, `hypdriv`, `create-hypdriv` | Preview |
| Cloudflare Workers (OpenNext, Worker shell, Durable Objects, handlers) | `@hypdriv/cloudflare` | Preview |
| Vercel (CDN cache and purge, Upstash, Global Config, WAF, BotID, Queues) | `@hypdriv/vercel` | Preview |
| Hono (a plain server framework, no build step) | `@hypdriv/hono` | Preview (verified locally on Node and workerd; live Cloudflare and Vercel runs pending) |
| Waku (React Server Components on Vite; 1.0 release candidates) | `@hypdriv/waku` | Preview (verified locally on Node, workerd and a real `vercel build` with the Vercel routing emulated; live Cloudflare and Vercel runs pending) |
| RedwoodSDK (React Server Components on Vite and Cloudflare Workers) | `@hypdriv/rwsdk` | Preview (Cloudflare Workers only; verified locally with a real build in workerd and a browser run under the nonce CSP; live Cloudflare run pending) |
| SolidStart 2 (Vite 8 and Nitro 3 deployment plugins) | `@hypdriv/solid-start` | Preview (verified locally on Node, workerd for the `@cloudflare/vite-plugin` and Nitro `cloudflare_module` builds, and a real offline `vercel build` with the Vercel routing emulated; live Cloudflare and Vercel runs pending) |
| Qwik (Qwik Router, v2 release candidates, on Vite) | `@hypdriv/qwik` | Preview (verified locally on Node, `vite preview`, the dev server, workerd and a real `vercel build` with the function invoked in process and the Vercel routing emulated; no browser run of hydration; live Cloudflare and Vercel runs pending) |
| Vite hosts: plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext | `@hypdriv/vite`, `@hypdriv/react-router`, `@hypdriv/tanstack-start`, `@hypdriv/astro`, `@hypdriv/sveltekit`, `@hypdriv/nuxt`, `@hypdriv/vinext` | Preview |
| Edge cache, security, observability | `@hypdriv/cache`, `@hypdriv/security`, `@hypdriv/observe` | Preview |
| Flags, live channels, images, DevTools HUD, testing kit | `@hypdriv/flags`, `@hypdriv/live`, `@hypdriv/image`, `@hypdriv/devtools`, `@hypdriv/testing` | Preview |
| Purser CSS bridge | `@hypdriv/purser` | Preview (needs `@avonao/purser` ≥ 0.1.0) |
| CLI: 17 commands, 100+ doctor checks | `@hypdriv/cli` | Preview |

## Test suites

| Suite | Scope | Result |
| --- | --- | --- |
| Unit and integration (Vitest, Node and workerd) | 30 packages | 2,405 tests in 213 files pass on Node 22 and 24; Node 20 runs the same suite except the vinext build test, which needs Node 22+ |
| Lint, typecheck, build, `publint` | all packages | pass |
| `e2e/cloudflare` | every capability on Cloudflare Workers | 41 pass · 0 fail · 2 skipped (inbound email, Turnstile pass flow) |
| `e2e/vercel` | every capability that applies on Vercel | 39 pass · 0 fail · 2 skipped (103 Early Hints are not available on Vercel, Turnstile pass flow) |
| `e2e/hosts` | the seven Vite hosts on Cloudflare and Vercel | all checks pass on 14 deployments; `hypdriv audit all` passes on all 14 |

## Verified environments

| Target | Frameworks | Date | Report |
| --- | --- | --- | --- |
| Cloudflare Workers (Free-plan zone, US-first) | Next.js 16.4 with `@opennextjs/cloudflare` 1.20 | 2026-10-30, re-run 2026-10-31 | [`testing/cloudflare-live-2026-10-30.md`](testing/cloudflare-live-2026-10-30.md) |
| Vercel (Hobby team, `iad1`) | Next.js 16.4 | 2026-10-31 | [`testing/vercel-live-2026-10-31.md`](testing/vercel-live-2026-10-31.md) |
| Cloudflare Workers and Vercel | Vite 8, React Router 8, TanStack Start, Astro 7, SvelteKit 3, Nuxt 4, vinext | 2026-10-31 | [`testing/vite-hosts-live-2026-10-31.md`](testing/vite-hosts-live-2026-10-31.md) |
| Node (`next start`, `hypdriv serve`, framework Node servers) | all hosts | continuous | the unit and integration suites |

## Distribution

Preview builds are not published to a package registry. They are distributed as packed tarballs through the release bundle (`scripts/release-bundle.mjs`, installed with `release/install.sh`) and can be built from source with `pnpm install && pnpm build`. See the [README](../README.md#install-a-preview-build).

## Next

[`roadmap.md`](roadmap.md) lists what follows: the OpenNext Adapter-API integration, `cloudflare.config.ts` support, a vitals dashboard page, route-level prerender diffs, edge experiments, smart warming and the 1.0 stability guarantees.

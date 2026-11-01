<p align="center">
  <img src="docs/assets/hypdriv-banner.png" alt="Hypdriv" width="100%">
</p>

<p align="center">
  <strong>Performance, security and observability for Next.js 16+ and Vite-based frameworks on Cloudflare Workers, Vercel and Node.</strong>
</p>

<p align="center">
  <a href="https://github.com/avonao/hypdriv/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/avonao/hypdriv/ci.yml?branch=main&label=ci"></a>
  <img alt="Status: Preview" src="https://img.shields.io/badge/status-preview-f59e0b">
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-0f766e">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0f766e"></a>
  <img alt="Next.js 16+" src="https://img.shields.io/badge/Next.js-16%2B-000000">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-f38020">
  <img alt="Vercel" src="https://img.shields.io/badge/Vercel-supported-000000">
  <img alt="Node 20.9+" src="https://img.shields.io/badge/node-%E2%89%A520.9-339933">
</p>

<p align="center">
  <a href="#install-a-preview-build">Install</a> ·
  <a href="docs/guides/getting-started.md">Getting started</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/ecosystem.md"><strong>Ecosystem: Purser CSS and SquawkCode</strong></a> ·
  <a href="docs/preview-status.md">Preview status</a>
</p>

Hypdriv is a **sidecar**. It attaches to a web application through the public extension points of its framework and platform (`next.config.ts`, the Adapter API, `proxy.ts`, Vite plugins, framework integrations, the Worker entry and your application code) and adds an edge cache, a CSP autopilot, rate limiting, a bot shield, feature flags, tracing and a command-line toolchain. It never patches Next.js, OpenNext, Vite, a framework or a platform builder.

It runs the same ordered pipeline, the **Drivetrain**, on three targets:

- **Cloudflare Workers**: Next.js through [OpenNext](https://opennext.js.org/cloudflare), and every supported Vite host through a Worker shell.
- **Vercel**: Next.js and every supported Vite host, with the stages in Routing Middleware.
- **Node**: `next start`, `hypdriv serve` and each framework's Node server.

Hypdriv needs **no infrastructure beyond the platform itself**. Platform services are optional upgrades that it detects at run time: Cloudflare KV, R2, D1, Durable Objects, Queues, Rate Limiting, Analytics Engine and Images on Workers; the Vercel CDN, Upstash Redis, Global Config, the Vercel WAF, BotID and Vercel Queues on Vercel.

> **Preview.** Hypdriv 0.1.0 is a Preview release. Preview releases are available to build with and evaluate ahead of general availability. Configuration keys, package APIs and the manifest format can change between Preview versions, and Preview builds are not covered by a service-level agreement. The [Preview status](#preview-status) section lists what is included, what has been verified and the constraints that apply.

## Contents

- [Highlights](#highlights)
- [Supported frameworks and platforms](#supported-frameworks-and-platforms)
- [Requirements](#requirements)
- [Install a Preview build](#install-a-preview-build)
- [Quickstart](#quickstart)
- [How it attaches](#how-it-attaches)
- [The Drivetrain](#the-drivetrain)
- [Capabilities](#capabilities)
- [Command line](#command-line)
- [Configuration](#configuration)
- [Packages](#packages)
- [Examples](#examples)
- [Ecosystem](#ecosystem)
- [Preview status](#preview-status)
- [Documentation](#documentation)
- [Develop from source](#develop-from-source)
- [Feedback, security and contributing](#feedback-security-and-contributing)
- [License](#license)

## Highlights

| Area | Hypdriv adds |
| --- | --- |
| **Speed** | Edge full-response cache with stale-while-revalidate, stale-if-error, tags, request coalescing and normalised keys · Early Hints (103) per route · Speculation Rules per route · flashless themes pinned at the edge · Worker weight reports and budgets · skew-protection assist · cache warming · Cloudflare image loader with placeholders · resilient `hypFetch` |
| **Security** | CSP autopilot (hash mode for static routes, nonce mode elsewhere, edge nonce injection for cached HTML, report-only rollout, collector and suggestions) · A+ security headers · rate limiting (fixed window, sliding window, token bucket; memory → Cache API → KV → Durable Object → Rate Limiting binding) · bot shield with Turnstile challenges · WAF-lite shield · `safeAction()` and `defineRoute()` with Standard Schema validation · encrypted sessions · JWT/JWKS · signed URLs and internal requests · webhook verification · password hashing · build-time secrets scan · Subresource Integrity |
| **Observability** | Tracing (OTLP/HTTP, console, Analytics Engine) · structured logs with redaction · `Server-Timing` for every stage · Web Vitals with route and cache attribution · `onRequestError` hooks · an in-app DevTools HUD |
| **Cloudflare-native** | Worker shell around OpenNext with `scheduled`, `queue`, `email` and `tail` handlers dispatched to Route Handlers · geo and locale negotiation · live channels (Durable Objects with SSE and WebSocket, polling fallback) · edge feature flags · KV-managed redirects · maintenance mode · typed bindings in server code |
| **Vercel-native** | Edge-cache policies expressed as `Vercel-CDN-Cache-Control` and `Vercel-Cache-Tag` (route headers, `withVercelCdn`) with tag purge on Vercel's CDN · Upstash Redis for exact global rate limits · Global Config for flags, redirects and maintenance · Vercel WAF rate-limit rules · BotID guards for Server Actions · Vercel Cron with `CRON_SECRET` · Vercel Queues for `enqueue()` · Vercel geo headers |
| **Vite hosts** | One integration per framework at its documented hook: plain Vite, React Router 8, TanStack Start, Astro 7, SvelteKit 3, Nuxt 4, vinext, Waku, RedwoodSDK, SolidStart 2 and Qwik (plus Hono as a plain server framework) · route manifest with CSP hashes of prerendered pages · static headers for Cloudflare, Vercel and Node · Cloudflare Worker entries that answer static files first · Vercel prerender-scoped Routing Middleware · Node servers |
| **Purser CSS** | In-process build and watch inside `withHypDriv` · unstyled-atom guard (a stale stylesheet fails the build) · atom usage reports · flashless themes · zero-override audits with headless Chrome |
| **Operations** | Signed operator purge (`hypdriv purge`, `POST /_hypdriv/purge`) that clears every cache tier · signed audit tokens so audits pass your own bot shield · a production implementation guide for Cloudflare |
| **Tooling** | The `hypdriv` CLI (17 commands, 100+ doctor checks, `--json` everywhere) · `create-hypdriv` scaffolder for thirteen frameworks · a testing kit · an agent skill |

The full list, with baseline and upgrade behaviour per feature, is in [`docs/feature-catalog.md`](docs/feature-catalog.md).

## Supported frameworks and platforms

| Framework | Integration | Cloudflare Workers | Vercel | Node |
| --- | --- | :---: | :---: | :---: |
| Next.js 16+ | `hypdriv`, `@hypdriv/next` | OpenNext | Routing Middleware | `next start` |
| Vite 8 (SPA and MPA) | `@hypdriv/vite` | Worker + static assets | Routing Middleware | `hypdriv serve` |
| React Router 8 (framework mode) | `@hypdriv/react-router` | Worker entry | Routing Middleware | Node server |
| TanStack Start | `@hypdriv/tanstack-start` | Worker entry | Routing Middleware | Nitro |
| Astro 7 | `@hypdriv/astro` | Worker entry | Routing Middleware | Node server |
| SvelteKit 3 | `@hypdriv/sveltekit` | Worker shell | Routing Middleware | Node server |
| Nuxt 4 | `@hypdriv/nuxt` | Worker shell around Nitro | Routing Middleware | Nitro |
| vinext | `@hypdriv/vinext` | Worker entry | Routing Middleware | Node server |
| Waku 1 | `@hypdriv/waku` | Worker shell around Waku's adapter | Routing Middleware | Node server |
| RedwoodSDK 1 | `@hypdriv/rwsdk` | Worker shell around `defineApp` | — | — |
| SolidStart 2 | `@hypdriv/solid-start` | Worker shell (`@cloudflare/vite-plugin`) or Nitro | Routing Middleware | Nitro |
| Qwik 2 (Qwik Router) | `@hypdriv/qwik` | Worker shell around Qwik Router | Routing Middleware | Node server |
| Hono 4 | `@hypdriv/hono` | Worker (`export default app`) | Function (`export default app`) | `@hono/node-server` |

Cloudflare and Vercel are the two first-class platforms ([ADR 0013](docs/adr/0013-deploy-targets.md)). Node is supported for local development, containers and self-hosting; capabilities that need a platform service report their baseline behaviour there.

Verification of each combination is recorded in [Preview status](#preview-status) and in [`docs/testing`](docs/testing).

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 20.9 or later for the core, runtime, Next.js, Cloudflare, Vercel packages and for the CLI. Vite packages need 20.19+, Astro and TanStack Start 22.12+, SvelteKit 22.17+, React Router 22.22+, vinext 22+, Waku 22.15+, RedwoodSDK 22.12+, SolidStart 22.12+ (SolidStart 2 itself declares Node 24), Qwik 20.19+. Loading a `hypdriv.config.ts` needs Node 22.13+ (22.18+ recommended); on older versions use `hypdriv.config.js` or `.mjs`. |
| Package manager | pnpm 10+ for this repository. Applications can use npm, pnpm, yarn or bun. |
| Next.js | 16.0 or later (App Router first, Pages Router supported) with React 19.2+. Verified on 16.4. |
| OpenNext for Cloudflare | `@opennextjs/cloudflare` 1.15+. Verified on 1.20. |
| Vite | 8.x. |
| Wrangler | 4.x. |
| TypeScript in host apps | 5.9 to 7. |
| Purser CSS (optional) | `@avonao/purser` 0.1+. |

Deprecated Next.js features (`middleware.ts`, Edge runtime segments) are detected and reported by `hypdriv doctor`; they are not supported. An application that keeps a `middleware.ts` uses `hypdriv init --no-proxy`.

## Install a Preview build

Preview builds are not published to a package registry. They are installed from packed tarballs (the *release bundle*) or built from source.

### From a release bundle

```sh
git clone https://github.com/avonao/hypdriv.git
cd hypdriv
pnpm install
pnpm build
node scripts/release-bundle.mjs --out ../hypdriv-bundle     # packs every package, writes SHA256SUMS, install.sh, templates and docs
```

The bundle contains one tarball per package (`tarballs/`), `SHA256SUMS`, the verified installer (`install.sh`), copy-ready templates and the documentation of that commit. See [`release/BUNDLE-README.md`](release/BUNDLE-README.md).

```sh
../hypdriv-bundle/install.sh path/to/your-next-app
```

`install.sh` verifies the checksums, copies the 16 tarballs a Next.js application needs into `vendor/hypdriv/` and runs `npm install --save` on them. Commit `vendor/hypdriv/` so CI can install the same bytes. Running the script from a newer bundle updates the application.

Vite-host applications install the tarballs of the packages they use (`@hypdriv/core`, `@hypdriv/vite` and the integration for their framework, plus `@hypdriv/cli`). Install the tarballs of one host at a time: the 30 tarballs are not installed together, because `@hypdriv/vinext`, `@hypdriv/waku`, `@hypdriv/rwsdk`, `@hypdriv/solid-start` and `@hypdriv/qwik` declare peers on `vinext`, `waku`, `rwsdk`, `@solidjs/start` and `@qwik.dev/router`.

### From source

```sh
pnpm install
pnpm build
pnpm test
```

Workspace packages resolve through the `source` export condition, so tests and type checks run against `src/` without building. The example applications in [`examples/`](examples) build and run against the workspace packages.

### Scaffold a new application

`create-hypdriv` scaffolds a ready-to-deploy application for any supported framework and platform. Run it from the bundle or from a source build, skip the install, and let the bundle installer add the packages:

```sh
node packages/create-hypdriv/dist/index.js my-app --framework next --platform cloudflare --no-install --pm npm
../hypdriv-bundle/install.sh my-app
```

Options, templates and what each template contains are in [`packages/create-hypdriv`](packages/create-hypdriv/README.md).

## Quickstart

### Next.js on Cloudflare Workers

```sh
npx hypdriv init                 # detects Next.js, OpenNext, wrangler, Purser and TypeScript, then writes the files below
npx hypdriv doctor               # 100+ checks with fixes (add --fix)
pnpm build                       # next build → .hypdriv/manifest.json and report.md
npx opennextjs-cloudflare build && npx opennextjs-cloudflare preview
npx hypdriv audit all --url http://localhost:8787
```

`hypdriv init` wraps `next.config.ts` in `withHypDriv()`, writes `hypdriv.config.ts`, `hypdriv.worker.ts` and `proxy.ts`, points `wrangler.jsonc#main` at the Worker entry, adds `public/_headers` for immutable assets and scripts for `doctor`, `analyze` and `audit`. Every file it touches is backed up as `<name>.hypdriv.bak`, and running it again is idempotent. Production setup (the OpenNext R2 cache, resources, secrets, probes, launch checklist) is covered step by step in the [production guide for Cloudflare](docs/guides/production-cloudflare.md).

### Next.js on Vercel

```sh
npx hypdriv init --platform vercel
VERCEL=1 pnpm build              # withHypDriv emits the Vercel CDN route headers
vercel deploy
```

There is no Worker entry on Vercel. `proxy.ts` runs the stages in Routing Middleware and wires the Vercel CDN, Upstash and Global Config stores, Vercel purges and WAF rules automatically. See the [Vercel guide](docs/guides/vercel.md).

### A Vite host

```ts
// vite.config.ts (plain Vite; each framework registers its integration at its own hook)
import { hypdriv } from '@hypdriv/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [hypdriv()] });
```

```sh
npx hypdriv init                 # registers the integration, writes the wrangler config, Worker entry and Vercel files
npx hypdriv doctor
pnpm build                       # writes .hypdriv/manifest.json, CSP hashes and static headers for the target
```

Guides: [Vite](docs/guides/vite.md) · [React Router](docs/guides/react-router.md) · [TanStack Start](docs/guides/tanstack-start.md) · [Astro](docs/guides/astro.md) · [SvelteKit](docs/guides/sveltekit.md) · [Nuxt](docs/guides/nuxt.md) · [vinext](docs/guides/vinext.md) · [Waku](docs/guides/waku.md) · [RedwoodSDK](docs/guides/rwsdk.md) · [SolidStart](docs/guides/solid-start.md) · [Qwik](docs/guides/qwik.md) · [Hono](docs/guides/hono.md).

## How it attaches

```ts
// next.config.ts
import { withHypDriv } from 'hypdriv/config';
export default withHypDriv({ cacheComponents: true });
```

```ts
// hypdriv.worker.ts  (wrangler.jsonc → "main")
import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from 'hypdriv/durable-objects';
export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
```

```ts
// proxy.ts  (Vercel, next dev, next start, any Node host; passes through inside the Cloudflare Worker)
import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from './hypdriv.config';
export default createProxy(hypdrivConfig);
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
}; // Next.js parses this statically, so it must be a literal
```

```tsx
// anywhere on the server
import { hyp, flag, safeAction, jobHandler } from 'hypdriv/server';
import { revalidateTag } from 'hypdriv/cache';      // Next revalidation + edge purge
```

At build time the chained adapter writes `.hypdriv/manifest.json`: routes, classifications (static, isr, shell, dynamic, route), per-route assets, CSP hashes, Early Hints, the link graph for Speculation Rules, Purser atom usage, weights and budgets. At request time the Drivetrain reads that manifest and runs its stages in the Worker (Cloudflare), in Routing Middleware (Vercel) or in the framework's request hook (Node and Vite hosts).

## The Drivetrain

The pipeline runs the same ordered stages on every target:

`request-id → maintenance → shield → bots → rate-limit → rate-limit-vercel → geo → i18n → flags → redirects → theme → speculation → csp → edge-cache → security-headers → early-hints → html-transforms → skew → devtools → observe`

Every stage reports a `Server-Timing` entry, so its effect is visible on every response and in the DevTools HUD. `rate-limit-vercel` exists on Vercel only; `html-transforms` and edge nonce injection need the Worker's `HTMLRewriter`. Details: [Architecture](docs/architecture.md) and [ADR 0005](docs/adr/0005-pipeline-model.md).

### Three identifiers

A deployment carries three distinct identifiers, and each has one job: the Next.js build id (used by Next.js itself and in the `build:<id>` cache tag), the Hypdriv deployment id (R2 key prefix and the `deployment` field of the health route) and the content fingerprint (edge-cache keys and the `x-hypdriv-build` header on HTML). See [ADR 0016](docs/adr/0016-deployment-ids-per-build.md) and [caching](docs/guides/caching.md).

## Capabilities

| Capability | Baseline (no extra infrastructure) | Upgrade (detected at run time) |
| --- | --- | --- |
| Edge cache | Per-isolate memory plus Cache API | KV on Cloudflare; Vercel CDN with `Vercel-Cache-Tag` purge on Vercel |
| Cache purge | `revalidateTag()` and `revalidatePath()` purge the edge cache; `hypdriv purge` for operators | Durable Object tag index on Cloudflare |
| Rate limiting | Memory, Cache API | KV, Durable Object, Cloudflare Rate Limiting binding; Upstash Redis and WAF rules on Vercel |
| Bot shield | Verified-bot allow-list, heuristics, honeypots, `Sec-Fetch-*` checks, signed audit exemptions | Cloudflare bot management scores, Turnstile challenges, BotID on Vercel |
| CSP | Hash mode for static routes, nonce mode elsewhere | Edge nonce injection into cached HTML (Worker `HTMLRewriter`) |
| Flags | Static and environment providers | KV, Vercel Global Config, OpenFeature |
| Jobs | Signed routes | Cloudflare cron, queues, email and tail handlers; Vercel Cron and Queues |
| Observability | Console and `Server-Timing` | OTLP/HTTP export, Analytics Engine, `hypdriv vitals` |
| Live channels | Polling fallback | Durable Objects with SSE and WebSocket (hibernation) |
| Images | `next/image` defaults | Cloudflare image loader, placeholders, `HypImage` |

Each capability has a guide: [caching](docs/guides/caching.md) · [security](docs/guides/security.md) · [observability](docs/guides/observability.md) · [flags](docs/guides/flags.md) · [live channels](docs/guides/live.md) · [jobs](docs/guides/jobs.md) · [Purser CSS](docs/guides/purser.md).

## Command line

The `hypdriv` command ships in `@hypdriv/cli` (and the `hypdriv` umbrella package). Every command supports `--json` and `--root`.

| Command | Purpose |
| --- | --- |
| `hypdriv init` | Detect the project and write or update the configuration, wrangler file, Worker entry, proxy and Vercel files (every supported host) |
| `hypdriv doctor` | 100+ checks for the detected framework and platform; `--fix` applies safe fixes, `--ci` fails the build on findings |
| `hypdriv analyze` | Worker weight report and route analysis |
| `hypdriv routes` | Routes with classification, revalidate, cache policy, CSP mode, hints, weights and Purser atoms; `--diff <manifest>` catches routes that became more dynamic between builds |
| `hypdriv audit` | Audits of `headers`, `csp`, `cache`, `https` and `css` (or `all`) against a running URL |
| `hypdriv budget` | Budgets from the manifest and the Worker report, snapshots and diffs |
| `hypdriv csp` | Static route hashes, allow-list suggestions from reports, the generated policy |
| `hypdriv css` | Purser build, check and watch through the bridge |
| `hypdriv warm` | Fetch warm routes with a signed audit token |
| `hypdriv purge` | Purge a running deployment's edge cache by tag, path or everything, through its signed `POST /_hypdriv/purge` |
| `hypdriv bench` | TTFB p50 and p95 and cache status distribution per path |
| `hypdriv deps` | Dependency freshness across the workspace with patch, minor and major classification |
| `hypdriv manifest` | Print or validate `.hypdriv/manifest.json` |
| `hypdriv jobs` | List jobs and run one through a signed internal request |
| `hypdriv vitals` | p75 Web Vitals per route from Analytics Engine |
| `hypdriv serve` | Serve a built Vite app on Node with the Drivetrain in front |
| `hypdriv agent` | Print agent guidance for the project |

Reference: [`docs/guides/cli.md`](docs/guides/cli.md).

## Configuration

```ts
// hypdriv.config.ts
import { defineConfig } from 'hypdriv';

export default defineConfig({
  site: { name: 'my-app', origin: 'https://www.example.com' },
  security: {
    csp: { allow: { scripts: ['https://js.stripe.com'] } },
    rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m' }],
  },
  cache: { edge: { policies: [{ match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] }] } },
  flags: {
    definitions: {
      newCheckout: { default: false, rules: [{ when: { country: ['US'] }, percentage: 25, value: true }] },
    },
  },
  jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } },
});
```

The configuration is validated at build and run time with precise error messages. The complete schema is in the [configuration reference](docs/guides/configuration.md).

## Packages

Twenty-eight packages, all at 0.1.0 (Preview). The `hypdriv` umbrella package re-exports the modules a Next.js application needs and ships the CLI.

| Package | Purpose | Node |
| --- | --- | --- |
| [`hypdriv`](packages/hypdriv) | Umbrella: every module below plus the CLI | ≥ 20.9 |
| [`@hypdriv/core`](packages/core) | Configuration schema, pipeline kernel, manifest, utilities | ≥ 20.9 |
| [`@hypdriv/runtime`](packages/runtime) | Framework-neutral stages, platform wiring, request handler for any Web `fetch` handler | ≥ 20.9 |
| [`@hypdriv/build`](packages/build) | Framework-neutral build engine: manifest, CSP hashes, Early Hints, speculation graph, secrets scan, budgets | ≥ 20.9 |
| [`@hypdriv/next`](packages/next) | `withHypDriv`, adapter chain, proxy composables, server and client helpers | ≥ 20.9 |
| [`@hypdriv/cloudflare`](packages/cloudflare) | Worker shell, scheduled/queue/email/tail handlers, Durable Objects, bindings | ≥ 20.9 |
| [`@hypdriv/vercel`](packages/vercel) | Vercel CDN headers and purge, Upstash and Global Config stores, WAF, BotID, Queues | ≥ 20.9 |
| [`@hypdriv/cache`](packages/cache) | Edge cache engine: policies, keys, SWR, coalescing, tags, purge | ≥ 20.9 |
| [`@hypdriv/security`](packages/security) | CSP, headers, rate limiting, bots, actions, sessions, crypto, webhooks, secrets scan | ≥ 20.9 |
| [`@hypdriv/observe`](packages/observe) | Tracing, logging, Server-Timing, Web Vitals | ≥ 20.9 |
| [`@hypdriv/flags`](packages/flags) | Edge feature flags | ≥ 20.9 |
| [`@hypdriv/live`](packages/live) | Live channels | ≥ 20.9 |
| [`@hypdriv/image`](packages/image) | Cloudflare image loader, placeholders, `HypImage` | ≥ 20.9 |
| [`@hypdriv/devtools`](packages/devtools) | In-app DevTools HUD | ≥ 20.9 |
| [`@hypdriv/testing`](packages/testing) | Fake bindings, request builders, pipeline harness, Vitest presets | ≥ 20.9 |
| [`@hypdriv/purser`](packages/purser) | Purser CSS bridge | ≥ 20.9 |
| [`@hypdriv/vite`](packages/vite) | Vite plugin and the integration toolkit | ≥ 20.19 |
| [`@hypdriv/react-router`](packages/react-router) | React Router (framework mode) | ≥ 22.22 |
| [`@hypdriv/tanstack-start`](packages/tanstack-start) | TanStack Start | ≥ 22.12 |
| [`@hypdriv/astro`](packages/astro) | Astro | ≥ 22.12 |
| [`@hypdriv/sveltekit`](packages/sveltekit) | SvelteKit | ≥ 22.17 |
| [`@hypdriv/nuxt`](packages/nuxt) | Nuxt | ≥ 20.19 |
| [`@hypdriv/vinext`](packages/vinext) | vinext | ≥ 22 |
| [`@hypdriv/waku`](packages/waku) | Waku | ≥ 22.15 |
| [`@hypdriv/rwsdk`](packages/rwsdk) | RedwoodSDK | ≥ 22.12 |
| [`@hypdriv/solid-start`](packages/solid-start) | SolidStart 2 | ≥ 22.12 |
| [`@hypdriv/qwik`](packages/qwik) | Qwik (Qwik Router, v2) | ≥ 20.19 |
| [`@hypdriv/hono`](packages/hono) | Hono | ≥ 22.12 |
| [`@hypdriv/cli`](packages/cli) | The `hypdriv` command | ≥ 20.9 |
| [`create-hypdriv`](packages/create-hypdriv) | Scaffolder | ≥ 20.9 |

## Examples

| Example | Framework | Platform | Notes |
| --- | --- | --- | --- |
| [`examples/basic`](examples/basic) | Next.js 16 | Cloudflare | Cache Components, PPR, KV, Durable Objects, Analytics Engine, Rate Limiting, Images, cron |
| [`examples/with-purser`](examples/with-purser) | Next.js 16 | Cloudflare | Adds Purser CSS, edge-pinned themes, zero-override audit |
| [`examples/vercel`](examples/vercel) | Next.js 16 | Vercel | Cache Components, PPR, route-header CDN policies, Queues, Cron |
| [`examples/vercel-purser`](examples/vercel-purser) | Next.js 16 | Vercel | Adds Purser CSS and a hashed theme script |
| [`examples/vite`](examples/vite) | Vite 8 | Cloudflare, Vercel, Node | Single-page app with an API route |
| [`examples/react-router`](examples/react-router) | React Router 8 | Cloudflare, Vercel, Node | Root middleware, nonce-aware server entry |
| [`examples/tanstack-start`](examples/tanstack-start) | TanStack Start | Cloudflare, Vercel, Node | Global request middleware |
| [`examples/astro`](examples/astro) | Astro 7 | Cloudflare, Vercel, Node | Prerendered pages, server island, endpoints |
| [`examples/sveltekit`](examples/sveltekit) | SvelteKit 3 | Cloudflare, Vercel, Node | Adapter wrapper, `handle` hook, merged CSP |
| [`examples/nuxt`](examples/nuxt) | Nuxt 4 | Cloudflare, Vercel, Node | Nitro plugin, `useHyp()` |
| [`examples/vinext`](examples/vinext) | vinext | Cloudflare, Vercel, Node | Request hook in every runtime |
| [`examples/waku`](examples/waku) | Waku 1 | Cloudflare, Vercel, Node | Adapter wrapper, `hyp()` in server components, rate-limited `_api` route |
| [`examples/rwsdk`](examples/rwsdk) | RedwoodSDK 1 | Cloudflare | `withHypDriv(defineApp)`, nonce hand-off, `hyp()` in server components, rate-limited API route |
| [`examples/solid-start`](examples/solid-start) | SolidStart 2 | Cloudflare, Vercel, Node | Nitro runtime plugin or Worker shell, `hypdrivStart()` nonce, Nitro-prerendered pages, `hyp()` in a server function, rate-limited API route |
| [`examples/qwik`](examples/qwik) | Qwik 2 | Cloudflare, Vercel, Node | Router adapters and server entries, prerendered and dynamic pages, `onStaticGenerate` paths, endpoint |
| [`examples/hono`](examples/hono) | Hono 4 | Cloudflare, Vercel, Node | `useHypDriv(app)` middleware, nonce in JSX, Durable Objects |

The end-to-end suites in [`e2e/`](e2e) (`cloudflare`, `vercel`, `hosts`) run every capability against a real account.

## Ecosystem

Hypdriv has two sister products from Avonao. They work on their own and fit together; the [ecosystem page](docs/ecosystem.md) describes each in detail, how the three connect, and how to adopt them.

| Product | What it is | Where it fits |
| --- | --- | --- |
| **[Hypdriv](https://github.com/avonao/hypdriv)** (this repository) | Sidecar for performance, security and observability on Cloudflare Workers, Vercel and Node | Builds the manifest, serves the site through the Drivetrain, audits the deployment |
| **[Purser CSS](https://github.com/avonao/purser)** (`@avonao/purser`) | Compile-time atomic CSS in which an overridden declaration, an `!important` and a raw color cannot happen | Writes the stylesheet. Hypdriv runs its build and watch in Next.js, guards against a stale stylesheet, reports atom usage per route, pins themes at the edge and audits a deployment for zero overrides ([guide](docs/guides/purser.md)) |
| **[SquawkCode](https://github.com/avonao/squawkcode)** (formerly ClassHash) | Hashes CSS class names in a copy of a site and proves with headless Chrome that no computed style changed | Runs before deploy. It proves that moving a site onto Purser, or hashing its class names, did not change how it looks; Hypdriv audits the result after deploy |

```
write (Purser) → build (Hypdriv adapter + manifest) → prove (SquawkCode gate) → serve (Hypdriv Drivetrain) → audit (hypdriv audit css)
```

All three are 0.1.0 Preview releases under the MIT license, distributed as source and tarballs. Hypdriv works without Purser, Purser without Hypdriv, and SquawkCode with either or neither. Details, compatibility across the three, adoption paths and an end-to-end CI example: [`docs/ecosystem.md`](docs/ecosystem.md).

## Preview status

| | Status |
| --- | --- |
| Release | 0.1.0 Preview |
| Implemented | Every capability in the [feature catalog](docs/feature-catalog.md) |
| Unit and integration tests | 2,405 tests in 213 files on Node 22 and 24 |
| Live runs | Next.js on Cloudflare Workers and on Vercel; seven Vite hosts on Cloudflare Workers and on Vercel |
| API stability | Not yet guaranteed. 1.0 will commit to the `defineConfig` schema, the manifest schema and semver |
| Distribution | Source and release-bundle tarballs |

### Verified

| Target | Scope | Result | Report |
| --- | --- | --- | --- |
| Cloudflare Workers | Next.js 16.4, OpenNext 1.20, every capability | 41 pass · 0 fail · 2 skipped | [report](docs/testing/cloudflare-live-2026-10-30.md) |
| Vercel (Hobby) | Next.js 16.4, every capability that applies | 39 pass · 0 fail · 2 skipped | [report](docs/testing/vercel-live-2026-10-31.md) |
| Cloudflare Workers and Vercel | Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext | all checks pass on 14 deployments | [report](docs/testing/vite-hosts-live-2026-10-31.md) |

`hypdriv audit all` (headers, CSP, cache, HTTPS) passes on every deployment above. Current numbers and the component table are in [`docs/preview-status.md`](docs/preview-status.md).

### Constraints in this Preview

- **Registry.** The packages are distributed as source and tarballs; a package-registry release follows the Preview.
- **Purser CSS.** The Purser integration needs `@avonao/purser` 0.1+, which is installed separately.
- **Node.js.** Several host packages require Node 22 or later (see [Requirements](#requirements)). The vinext build test is skipped on Node 20.
- **Next.js versions.** Next.js 16.x is supported; Next.js 17 support is planned for 1.0 ([roadmap](docs/roadmap.md)).
- **OpenNext.** Hypdriv builds on `@opennextjs/cloudflare`'s current output. The Adapter-API-based integration is planned for 0.2.
- **Early Hints.** HTTP 103 responses are produced on Cloudflare; Vercel does not forward them.
- **Exact global rate limits on Vercel** need Upstash Redis; without it, counters are per function instance.
- **Inbound email** (`email` handler) and the Turnstile pass flow are covered by tests and by separate runs with test credentials, and are skipped in the live suites.
- **Preview stability.** Configuration keys, package APIs and the manifest format can change between Preview versions; changes are recorded in changesets.

Planned work is tracked in [`docs/roadmap.md`](docs/roadmap.md).

## Documentation

- **Concepts:** [Architecture](docs/architecture.md) · [Ecosystem: Purser CSS and SquawkCode](docs/ecosystem.md) · [Feature catalog](docs/feature-catalog.md) · [Decision records](docs/adr/README.md) · [Package contracts](docs/contracts.md) · [Preview status](docs/preview-status.md) · [Roadmap](docs/roadmap.md)
- **Start:** [Getting started](docs/guides/getting-started.md) · [Configuration reference](docs/guides/configuration.md) · [CLI](docs/guides/cli.md)
- **Platforms:** [Cloudflare](docs/guides/cloudflare.md) · [Production on Cloudflare](docs/guides/production-cloudflare.md) · [Vercel](docs/guides/vercel.md)
- **Frameworks:** [Vite](docs/guides/vite.md) · [React Router](docs/guides/react-router.md) · [TanStack Start](docs/guides/tanstack-start.md) · [Astro](docs/guides/astro.md) · [SvelteKit](docs/guides/sveltekit.md) · [Nuxt](docs/guides/nuxt.md) · [vinext](docs/guides/vinext.md) · [Waku](docs/guides/waku.md) · [RedwoodSDK](docs/guides/rwsdk.md) · [SolidStart](docs/guides/solid-start.md) · [Qwik](docs/guides/qwik.md) · [Hono](docs/guides/hono.md)
- **Capabilities:** [Caching](docs/guides/caching.md) · [Security](docs/guides/security.md) · [Observability](docs/guides/observability.md) · [Purser CSS](docs/guides/purser.md) · [Flags](docs/guides/flags.md) · [Live channels](docs/guides/live.md) · [Jobs](docs/guides/jobs.md)
- **Test reports:** [`docs/testing`](docs/testing)
- **Coding agents:** [`AGENTS.md`](AGENTS.md) and [`skills/hypdriv`](skills/hypdriv/SKILL.md)

## Develop from source

```sh
pnpm install
pnpm build              # tsdown for every package
pnpm test               # Vitest (Node and Workers projects)
pnpm typecheck          # tsc --noEmit per package
pnpm lint               # Biome
pnpm changeset          # record a user-visible change
```

Continuous integration runs lint, build, typecheck, tests and `publint` on Node 20, 22 and 24. Layout, conventions and the end-to-end verification steps are in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Feedback, security and contributing

- **Bugs and feature requests:** open an issue with the templates in this repository. Include the output of `npx hypdriv doctor --json` and a minimal reproduction.
- **Security:** report vulnerabilities privately through GitHub's *Report a vulnerability* on the Security tab. See [`SECURITY.md`](SECURITY.md).
- **Contributing:** see [`CONTRIBUTING.md`](CONTRIBUTING.md). Public API changes need tests, documentation, a changeset and a feature-catalog entry.
- **Conduct:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Avonao, Inc. and Hypdriv contributors.

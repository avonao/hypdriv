# Hypdriv in production on Cloudflare: implementation guide

<!-- Maintainers: the release bundle's templates/ are cut from the first fenced block under the headings "### 5.3 ", "### 5.4 ", "### 5.5 ", "### 5.6 " and "### 6.1 " of this file (scripts/release-bundle.mjs fails when a heading or a fence language changes). -->

This guide takes a Next.js 16 application that runs on Cloudflare Workers through OpenNext and puts Hypdriv in front of it, on production infrastructure: codebase, build, Cloudflare resources, zone settings, secrets, deploy order, verification and operations. It is written for the engineers and the Claude chats that will do the work, so every step has the exact command or file and a way to tell it worked.

Read §1–§4 completely before touching anything. Then follow §5 (one app, one Worker) or §9 (a fleet of area Workers behind a router). §12 is the launch checklist.

**How far each statement is proven.** Everything marked **[verified]** was run end to end on 2026-10-31 against a faithful copy of a production multi-area platform (Next 16.4.3, React 19.2.6, OpenNext 1.20.15, wrangler 4.156.0, webpack builds, the area generator, middleware, the full production binding set): `next build --webpack`, `hypdriv doctor` (0 fail), local workerd through `wrangler dev` with the populated R2 cache, `hypdriv audit all` (headers, CSP, cache, HTTPS), the Durable Object rate limiter, and `wrangler deploy --dry-run` of the full binding set. Nothing in those runs touched a Cloudflare account. Everything marked **[first deploy]** can only be proven on the real account; §11 gives one probe for each.

---

## 1. What you are deploying

```
Browser → Cloudflare edge (zone: HTTPS redirect, WAF, your custom domain / zone route)
        → Worker = Hypdriv shell (hypdriv.worker.ts, createWorker)
             request-id → maintenance → shield → bots → rate-limit → geo → redirects → speculation
             → csp → edge-cache → security-headers → early-hints → skew → devtools → observe
          → OpenNext worker (.open-next/worker.js) → Next.js (+ the app's own middleware.ts)
          → R2 incremental cache · Durable Object tag cache + queue · static assets
```

- **One Worker per Next build.** `hypdriv.worker.ts` is the Worker entry; it wraps `.open-next/worker.js`. `opennextjs-cloudflare build` still produces the OpenNext output; wrangler bundles `hypdriv.worker.ts` and everything it imports.
- **The application keeps its code.** `middleware.ts`, route handlers, `next.config.ts` rewrites/redirects/headers keep working. Hypdriv is a sidecar: it never patches Next, OpenNext or wrangler.
- **Headers the application sets itself are preserved; Hypdriv only fills gaps.** That is why a few routes need explicit exceptions (§6.3).
- **Static assets are answered by Cloudflare before the Worker runs.** They never see the pipeline, and they never see `forceHttps` (rule 8).
- **Everything beyond the baseline is a binding.** The Worker works with none; production uses all of them (§7.1).

Out of scope: Vercel (see the [Vercel guide](vercel.md)), and plain Worker fleets that are not Next apps (API gateways, queue consumers): they keep running as they are. Hypdriv has no integration for them.

---

## 2. The rules that break production

Each one was found by a failure in the simulations or the live runs. Break one and the symptom in the right column is what you will see.

| # | Rule | If you break it |
| --- | --- | --- |
| 1 | **Populate the R2 incremental cache before the first request**, on every deploy, before `wrangler deploy` takes traffic: `opennextjs-cloudflare populateCache remote --config <wrangler file>`, or `opennextjs-cloudflare deploy` which does both. | Pages with a hash CSP render per request, Next streams their flight data in different chunks, the build-time hashes no longer match, Hypdriv's edge cache keeps that page for days (5 minutes fresh, one day stale-while-revalidate, seven days stale-if-error; the KV copy lives as long), and browsers (which ignore `'unsafe-inline'` next to hashes) block the inline scripts: **the page loads and never hydrates**. Recovery: populate, then rebuild and redeploy (a new build has a new deployment id, which changes every edge-cache key, so nothing from the broken build is served), or `hypdriv purge --url <base> --all` (§8.4); a raw Cloudflare tag purge is not enough, it leaves the KV copy. Break-glass: `security.csp.mode: 'nonce'`. `hypdriv doctor` fails (`opennext.cache`) when `open-next.config.ts` configures no incremental cache; it cannot see a skipped populate step, which is a rule for the deploy script. |
| 2 | **`middleware.ts` present ⇒ `hypdriv init --no-proxy`.** Never have `proxy.ts` and `middleware.ts` side by side. | `proxy.ts` only serves `next dev` / `next start`; on Cloudflare the Worker shell runs the pipeline and the existing `middleware.ts` keeps working inside it. Next 16 treats `proxy.ts` as the replacement of `middleware.ts`: both side by side is not a supported combination, and `proxy.ts` would do nothing in the Worker anyway. |
| 3 | **Relative imports inside `hypdriv.config.ts` need explicit `.ts` extensions** (`import { x } from '../../shared.ts'`). Build machines run Node 22.18+ (or 24). | Node's own ES module loader reads the config (native type stripping), which does not resolve extensionless paths. The error now names the fix: `"./shared" … write './shared.ts'`. In a fleet add `"allowImportingTsExtensions": true` to the area `tsconfig.json`. |
| 4 | **`withHypDriv(config)` is the outermost wrapper and returns an async function.** Never spread its result (`{...withHypDriv(x)}`) and never hand it to code that expects a plain object. | `next build` fails or Hypdriv silently does not run. In a fleet the root `next.config.ts` stays a plain object and each generated area config calls `withHypDriv`. |
| 5 | **Install Hypdriv only from the release bundle's tarballs** (it is not on npm): the 16 tarballs of §4 (the umbrella `hypdriv` and 15 `@hypdriv/*`), all from one bundle. | Mixed bundles fail with peer or version conflicts. Installing all 26 tarballs fails on a `vinext` or `waku` peer conflict. |
| 6 | **Use the bundle dated 2026-10-31 or later.** Earlier tarballs fail `next build --webpack`, loop redirects on `trailingSlash: true` sites and block the inline scripts of `generateStaticParams` pages. | `UnhandledSchemeError: node:fs/promises` through `instrumentation.ts`; `secret pattern env:NEXT_DEPLOYMENT_ID` from the client-asset secrets scan; `/page/` answering `308 → /page/` from the edge cache; CSP violations and React error 412 on every page of a dynamic route but the first. All fixed in the bundle. |
| 7 | **The edge cache answers before the application's `middleware.ts`.** List every cookie / header the middleware gates on in `cache.edge.bypass` (for example a `site_gate` cookie). | A page cached for an unlocked visitor is served to anonymous ones: **the pre-launch site gate is bypassed on every cached route.** `hypdriv doctor` warns (`cache.middleware`). |
| 8 | **Turn on HTTPS redirection in the zone for every host the Worker serves** (SSL/TLS → Edge Certificates → Always Use HTTPS, or a host-scoped Redirect Rule). | Workers Static Assets answer before the Worker, so content-hashed assets (and prerendered pages without `run_worker_first`) are reachable over plain HTTP. `hypdriv audit https` finds it. |
| 9 | **`workers_dev: false` and `preview_urls: false`.** Serve through a custom domain or a zone route, never `*.workers.dev`. | The Cache API is a no-op on `workers.dev`, so the regional cache and Hypdriv's Cache API tier do nothing, and the Worker has a second public door. |
| 10 | **The application's own headers win.** Hypdriv's defaults (`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-site`, a strict CSP on pages) apply wherever the app set nothing. Machine-facing and embeddable routes get explicit exceptions (§6.3). | Embeds stop framing, cross-origin SDK loads fail, `.well-known` clients choke. |
| 11 | **The bot shield blocks automation user agents (`curl`, `python-requests`, `axios`, `okhttp`, `Go-http-client`, headless browsers, an empty UA) on document requests** when `definitelyAutomated: 'block'`. Exempt every route that machines legitimately read (§6.3). | Agent-facing docs, `llms.txt`, OpenAPI files and webhooks answer `403` to the clients they are written for. |
| 12 | **Set both secrets before the first request**: `HYPDRIV_SESSION_SECRET` and `HYPDRIV_INTERNAL_SECRET`, ≥ 32 random bytes each, as Worker secrets (never in `wrangler.jsonc`, never in git). | Internal requests (cron, queue, jobs) are rejected; sessions and the audit token cannot be signed. |
| 13 | **Never share a deployment id between builds or apps on one zone.** Hypdriv's default (`<commit>-<build stamp>`, ADR 0016) is unique per build; leave it. | The Cache API is per zone: two builds with one id serve each other's HTML. |
| 14 | **Hypdriv's `scheduled` handler runs only the crons declared in `jobs.cron`** and ignores the rest. If the application already has a `scheduled` handler, chain it explicitly (§8.7). | Existing cron jobs silently stop. |
| 15 | **`ratelimits[].namespace_id` is unique per account** (shared namespace = shared counters across Workers). Allocate per Worker; ranges in §7.2. | Two Workers throttle each other. |
| 16 | **First deploy of a Worker with Durable Objects is `wrangler deploy`** (it applies the `migrations`), not `versions upload`. Migration tags are append-only. | The classes are not created and every binding to them fails. |
| 17 | **`pnpm`/`npm` consistency:** the platforms this guide was written for use npm, and the tarballs were verified with npm. Do not switch package managers on launch day. | pnpm with `file:` tarballs was not exercised. |

---

## 3. Prerequisites

| Item | Required | Tested |
| --- | --- | --- |
| Node | ≥ 22.18 on build machines and CI (config loader uses native type stripping; 22.13+ works through `stripTypeScriptTypes`) | 22.23.4 |
| npm | 10+ | 10.9.9 |
| Next.js / React | `next >=16.4.1` with OpenNext 1.20 (OpenNext's range is `>=15.5.28 <16 \|\| >=16.4.1`; Hypdriv alone needs `>=16.0.0`), `react ^19` | 16.4.3 / 19.2.6 |
| `@opennextjs/cloudflare` | ^1.20 | 1.20.15 |
| wrangler | ^4.152 | 4.156.0 |
| TypeScript | ^5.6 | 5.9.3 |
| Cloudflare plan | **Workers Paid** for production (30 s CPU default, 10,000 subrequests, Durable Objects at scale, R2, Analytics Engine, Rate Limiting binding) | n/a |
| Cloudflare token for deploys (typical scopes, adjust to your account's token policy) | Workers Scripts:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, Account Settings:Read; Zone:Read and Workers Routes:Edit on the zone for route-attached Workers | n/a |
| Token for cache purges (a **secret** of the Worker) | Zone → Cache Purge only, scoped to the one zone | n/a |
| Analytics Engine | enabled once per account (dashboard) | n/a |

**US first.** Everything is created in the US account and US entities. R2 buckets take the location hint `enam` (`wrangler r2 bucket create <name> --location enam`; the hint is honored only when the bucket is first created). KV is global. Durable Objects settle near their first caller. EU resources exist only where an EU deployment requires them (jurisdiction `eu` on R2/D1), added next to the US ones, never instead of them.

---

## 4. Get Hypdriv

Hypdriv is not on npm. It ships as vendored tarballs in a release bundle:

```
hypdriv-<version>-<date>/                the bundle folder (its location is given to you with the task)
  README.md             how the bundle works
  VERSION               0.1.0
  SHA256SUMS            checksums of every tarball
  tarballs/             25 × hypdriv-<name>-0.1.0.tgz (a Next.js app needs 16 of them)
  install.sh            verified installer (below)
  fleet/                (private bundles of fleet platforms) the generator patch of §9.2 and a reference diff of it
  PLATFORMS.md          (private bundles) hosts, names and deltas of each platform, §10
  templates/            copy-paste files from §5 and §6
  docs/                 the Hypdriv docs; this guide is docs/guides/production-cloudflare.md
  skills/hypdriv/       the agent skill for adopting Hypdriv in an application
  AGENTS.md, LICENSE    guidance for coding agents working on Hypdriv itself; the license
  PROMPT-FOR-CHATS.md   the paste-in prompt for a chat that has to implement this
```

**Install into an app:**

```sh
<bundle>/install.sh <app root>          # verifies SHA256SUMS, copies the 16 tarballs to <app root>/vendor/hypdriv/, runs npm install --save
```

**[verified]** on a clean Next 16.4.3 app (fresh install) and as an in-place update with a changed tarball of the same version: other lock entries stay byte-identical, the Hypdriv entries get the new integrity hashes. The manual equivalent, for a machine without `bash`:

```sh
cd <bundle>/tarballs && shasum -a 256 -c ../SHA256SUMS && cd -                      # integrity
mkdir -p vendor/hypdriv && cp <bundle>/tarballs/hypdriv-{,core-,build-,runtime-,cache-,security-,observe-,purser-,flags-,live-,image-,devtools-,vercel-,cloudflare-,next-,cli-}0.1.0.tgz vendor/hypdriv/
rm -rf node_modules/hypdriv node_modules/@hypdriv                                    # only when replacing an installed bundle (see below)
npm install --save vendor/hypdriv/hypdriv-0.1.0.tgz vendor/hypdriv/hypdriv-{core,build,runtime,cache,security,observe,purser,flags,live,image,devtools,vercel,cloudflare,next,cli}-0.1.0.tgz
```

- Commit `vendor/hypdriv/` to the app repository. CI builds from it. Check that `.gitignore` does not exclude `*.tgz` or `vendor/` (`git check-ignore -v vendor/hypdriv/hypdriv-0.1.0.tgz` must print nothing).
- `package.json` then holds `"hypdriv": "file:vendor/hypdriv/hypdriv-0.1.0.tgz"` and the 15 `@hypdriv/*` entries.
- The bundle is immutable. A new bundle gets a new directory. **Updating means running the new bundle's `install.sh` again.** All bundles carry the version `0.1.0`, so npm sees "up to date" after the tarballs are replaced and installs nothing; `install.sh` therefore deletes `node_modules/hypdriv`, `node_modules/@hypdriv` and the Hypdriv entries of `package-lock.json` before it installs (every other lock entry is kept). CI keeps using `npm ci`: the lock file pins the tarball integrity hashes, so a changed tarball without a changed lock file fails loudly.
- Also needed in the app: `@opennextjs/cloudflare`, `wrangler` (dev dependency), `next`, `react`, `react-dom` at the versions in §3.

---

## 5. One Next app, one Worker

This is the whole recipe for a single app. A fleet applies it once per area through its generator (§9). **[verified]** unless marked.

### 5.1 `hypdriv init`

```sh
npx hypdriv init --no-proxy      # --no-proxy is mandatory when middleware.ts exists (rule 2)
```

`init` is idempotent and backs up what it edits as `<file>.hypdriv.bak`. On a middleware app, `init --dry-run --no-proxy` plans exactly this: create `hypdriv.config.ts`, `hypdriv.worker.ts`, `.dev.vars.example` and `instrumentation.ts` (error-reporting hooks `register` / `onRequestError`); modify `next.config.ts` (wraps the default export in `withHypDriv()`), `tsconfig.json` (excludes `hypdriv.worker.ts`, which imports build output), `wrangler.jsonc` (`main` → `hypdriv.worker.ts`) and `package.json` (adds `hypdriv:doctor`, `hypdriv:analyze`, `hypdriv:audit`, `cf-typegen` scripts); skip `public/_headers` when the immutable `/_next/static/*` rule is already there. Review every diff, then make the files match the versions below. A fleet generates them (§9) instead of running `init` per area.

What `init` does **not** do, and doctor only reports as warnings: it writes no OpenNext cache overrides (§5.4), no Wrangler bindings or Durable Object migrations (§5.6), and its `hypdriv.config.ts` is a scaffold, not a production policy. Replace the scaffold with §6.1. Its defaults do not fit a production site: `budgets` of 300 kB route JavaScript and a 3 MB Worker (a real Next app routinely has 400 to 550 kB gzip per route and a 5 MB Worker, so every route is reported over budget; that is a warning unless `budgets.failOn` is `'error'`), `bots.definitelyAutomated: 'block'` (the default list contains `python-requests`, `node-fetch`, `axios`, `Go-http-client`, `okhttp` and `curl/`, i.e. your own scripts and partners) and `speculation.prerender` (an inline script that needs a CSP decision). It appends `.dev.vars`, `.hypdriv/` and `*.hypdriv.bak` to `.gitignore`; delete the `*.hypdriv.bak` backups after reviewing the diff.

### 5.2 `hypdriv.config.ts`

The policy of the app. Start from §6.1 (the production template). Imports from other files use `.ts` extensions (rule 3).

### 5.3 `next.config.ts`

```ts
import type { NextConfig } from 'next';
import { withHypDriv } from 'hypdriv/config';

const nextConfig: NextConfig = {
  // ...the application's own config, unchanged
};

export default withHypDriv(nextConfig);   // outermost wrapper; if you also use next-intl / bundle-analyzer, wrap those first
```

`withHypDriv` takes options when needed: `config` (inline config instead of the file), `configFile`, `projectDir` (default `process.cwd()`), `adapter`, `target`. It registers the Hypdriv adapter (`adapterPath`), writes `.hypdriv/adapter-config.json` and, at build time, `.hypdriv/manifest.json` and `.hypdriv/manifest.js`, and sets a per-build deployment id (ADR 0016).

### 5.4 `open-next.config.ts`: the production cache (not the empty default)

```ts
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import purgeCache from '@opennextjs/cloudflare/overrides/cache-purge/index';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import { withRegionalCache } from '@opennextjs/cloudflare/overrides/incremental-cache/regional-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';
import doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';

export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: 'long-lived' }),
  queue: doQueue,
  tagCache: doShardedTagCache({ baseShardSize: 12 }),
  cachePurge: purgeCache({ type: 'durableObject' }),
});
```

`defineCloudflareConfig({})` is OpenNext's no-op default: no persisted prerenders (rule 1), no ISR revalidation, `revalidateTag()` / `revalidatePath()` change nothing. Many apps ship this empty default today; replacing it is part of the work.

### 5.5 `hypdriv.worker.ts`

```ts
import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from 'hypdriv/durable-objects';
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),   // written by `next build`
});
```

`createWorker` returns `{ fetch, scheduled, queue, email, tail }`. `next:` takes OpenNext's worker; `app:` takes any module with a default `fetch` (Vite hosts). Both Durable Object families must be exported from the entry; `hypdriv doctor` checks it.

### 5.6 `wrangler.jsonc`

Names: `<app>` is the Worker name; US-first resources; no `workers.dev`.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "<app>",
  "main": "hypdriv.worker.ts",
  "compatibility_date": "2025-03-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "workers_dev": false,
  "preview_urls": false,
  "observability": { "enabled": true },

  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "<app>" }],
  "r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "<app>-opennext-cache" }],
  "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "<kv namespace id>" }],
  "durable_objects": { "bindings": [
    { "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DOQueueHandler" },
    { "name": "NEXT_TAG_CACHE_DO_SHARDED", "class_name": "DOShardedTagCache" },
    { "name": "NEXT_CACHE_DO_PURGE", "class_name": "BucketCachePurge" },
    { "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" },
    { "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" },
    { "name": "HYPDRIV_INDEX", "class_name": "HypDrivIndex" }
  ] },
  "migrations": [
    { "tag": "opennext-v1", "new_sqlite_classes": ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"] },
    { "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }
  ],
  "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "<app>_hypdriv" }],
  "ratelimits": [{ "name": "HYPDRIV_RATE_LIMIT", "namespace_id": "<unique per account>", "simple": { "limit": 120, "period": 60 } }]
}
```

Notes:

- `compatibility_date` must be ≥ `2024-09-23` (doctor); keep the platform's existing date, flags and settings (an existing platform may run `2025-03-01` + `nodejs_compat` and `upload_source_maps: false` to stay under the 60 MiB source-map cap) and add nothing the app did not already need. `global_fetch_strictly_public` was not exercised.
- `WORKER_SELF_REFERENCE` points at the Worker's **own** name: OpenNext's revalidation queue re-requests pages through it. The Hypdriv Worker recognizes those requests (by a SHA-256 of the preview-mode id in the manifest) and sends them straight to Next.
- A shared R2 bucket is fine for several Workers: give each Worker its own key prefix with the var `NEXT_INC_CACHE_R2_PREFIX` (`"<worker>/"`). Keys become `<prefix><deploymentId>/<hash>.cache`, where the deployment id is Hypdriv's per-build id (the `deployment` field of `/_hypdriv/health`, §8.5). The var must be in the same wrangler config `populateCache` reads (rule 1).
- The `ratelimits` binding is optional (it backs `store: 'binding'` policies, 10 s / 60 s windows). The exact, global limiter is the `HYPDRIV_LIMITER` Durable Object. The sample is verified to pass `wrangler deploy --dry-run`.
- `hypdriv doctor --fix` keeps cron triggers, observability and `_headers` in sync; it never invents resource ids.
- **Wrangler environments (`env.<name>`) do not inherit bindings.** `main`, `assets`, `compatibility_*`, `observability`, `migrations` and `workers_dev` are inherited; `vars`, `services`, `kv_namespaces`, `r2_buckets`, `durable_objects`, `analytics_engine_datasets`, `ratelimits` and the other binding kinds are **not**. An environment that omits them deploys cleanly (Wrangler only prints a warning) and then runs without the cache, the limiter or the self reference. Repeat the complete set in every environment, with the environment's own `WORKER_SELF_REFERENCE` (the Worker name it deploys as: `<name>-<env>` unless the environment sets `name`), its own R2 prefix, KV namespace, Analytics Engine dataset and Rate Limiting `namespace_id`. `npx hypdriv doctor` warns (`wrangler.env-bindings`) for an environment that lacks a binding kind the top level declares, and `npx hypdriv doctor --env <name>` (`HYPDRIV_WRANGLER_ENV`) runs every check against that environment as Wrangler resolves it; `hypdriv analyze --env <name>` measures it. Run both for each environment in CI. **[verified]** with `wrangler deploy --dry-run --env <name>` (4 Workers, one config).

### 5.7 Secrets and local variables

Production (per Worker): `HYPDRIV_SESSION_SECRET`, `HYPDRIV_INTERNAL_SECRET`, `CACHE_PURGE_ZONE_ID`, `CACHE_PURGE_API_TOKEN`; optional `OTLP_HEADERS` (OTLP exporter), Turnstile secret for challenge bot actions. Generate and set (the value is read from stdin, so it never appears in a process list):

```sh
openssl rand -base64 48 | npx wrangler secret put HYPDRIV_SESSION_SECRET  --name <worker>
openssl rand -base64 48 | npx wrangler secret put HYPDRIV_INTERNAL_SECRET --name <worker>
```

Local: `.dev.vars` (git-ignored) with the same two names and throwaway values, plus `.dev.vars.example` committed with names only. `hypdriv audit`, `warm` and `purge` derive their signed tokens from `HYPDRIV_INTERNAL_SECRET` (the environment, or `.dev.vars` in the app directory). Never commit a real value, never print one.

Optional after launch: render `<VitalsReporter />` (and `<HypDrivDevTools />`, which only shows in development and preview) from `hypdriv/client` in the root layout to collect Web Vitals into Analytics Engine. It is a client-bundle change that the go-live rehearsal does not cover; do it as its own change with its own build, not in the launch deploy.

### 5.8 Build, doctor, rehearse **[verified]**

```sh
npx opennextjs-cloudflare build                          # runs `next build` (add --webpack in package.json if the app builds with webpack)
npx hypdriv doctor --ci                                  # must report 0 failed checks
rm -rf .wrangler/state                                   # never rehearse on top of an old local cache
npx opennextjs-cloudflare populateCache local            # rule 1, locally
npx wrangler dev --port 8787                             # real workerd, all bindings emulated
npx hypdriv audit all --url http://127.0.0.1:8787        # headers, CSP, cache, (+ https on https URLs)
```

All audits must pass. Under `wrangler dev` the exact-limiter Durable Object runs; under `next dev` Hypdriv uses in-memory counters (expected warning).

`doctor` skips `size.worker` and `size.startup-risk` until `npx hypdriv analyze` has produced the Worker measurement (it runs its own `wrangler deploy --dry-run`), so a pipeline with only `doctor` has no bundle-size gate: run `analyze` before `doctor` in CI (§8.1). `analyze` itself only reports budget overruns as warnings; it fails a pipeline only when the policy sets `budgets.failOn: 'error'` (the default is `'warn'`). `hypdriv.worker.ts` is a **TypeScript** `main`: Wrangler bundles it at deploy time, so the deploy job needs `.open-next/`, `.hypdriv/`, `hypdriv.config.ts`, `node_modules/hypdriv` and `node_modules/@hypdriv/*` next to it (a job that restores only `.open-next/` fails to resolve `./.hypdriv/manifest.js`). **[verified]**: four environments bundled to a byte-identical Worker from the same inputs.

Up to three doctor warnings are expected on a first run (the second only on an app that keeps `middleware.ts`), and all of them are decisions, not defects. **[verified]** on a fresh Next 16.4.3 app without middleware, built from the bundle's templates alone: 71 pass, 2 warn (the first and the third), 0 fail; `wrangler deploy --dry-run` accepts all 11 bindings:

- `wrangler.compatibility-date` says the date is old. Do not change it in the launch change: a new date changes runtime behaviour. Keep the platform's date, and move it forward as its own change after launch. A brand-new app can start with the first of the current month (never later than the installed `workerd` supports).
- `next.middleware-deprecated` (and the matching `hypdriv.manifest-warnings`) on an app that keeps `middleware.ts` on purpose (rule 2): accepted, there is no suppression key. Rename it to `proxy.ts` as its own change after launch.
- `hypdriv.headers-file`: `npx hypdriv doctor --fix` writes `public/_headers` with the immutable rule for `/_next/static/*`. Commit the file once in the application's `public/` (a fleet copies it into every area). Note that `--fix` also adds the Hypdriv scripts to `package.json`; review that diff.

### 5.9 Coming from Next 15 **[verified]** on a 226-page Next 15.5 to 16.4.3 app

Hypdriv needs Next 16.4.1+ on OpenNext 1.20 (OpenNext's range is `>=15.5.28 <16 || >=16.4.1`; Hypdriv alone accepts `>=16.0.0`), so an app on Next 15 upgrades first, as its own change, before Hypdriv goes in. What an upgrade hit, in order:

1. **Versions.** `next`, `react`, `react-dom` (pin exact), `@opennextjs/cloudflare`, `wrangler`, `next-intl` (or your i18n library) to current releases. `wrangler` 4.14x and newer peer on `@cloudflare/workers-types` **5.x**: bump it in the same install or npm fails with `ERESOLVE`.
2. **`eslint` key in `next.config.ts`** is now a hard type error (`'eslint' does not exist in type 'NextConfig'`): delete the key and gate lint separately.
3. **`tsconfig.json` is rewritten by Next on the first build** (`jsx` becomes `react-jsx`, `.next/dev/types/**/*.ts` is added to `include`, arrays are reformatted): apply those edits by hand, in the file's own format, so the build leaves no diff.
4. **Turbopack is the default builder and breaks ``import(`@/alias/${x}`)``** under OpenNext at run time: the build succeeds and every route that loads the module returns 500 (`Cannot find module '@/messages/en/x.json'`, `MODULE_NOT_FOUND`). Use a relative path in the template literal (`../../messages/${x}.json`), or build with `next build --webpack`. Find them with ``grep -rn 'import(`' src app lib``; test every route that loads data dynamically, signed-in ones included: nothing in the build output reveals this.
5. **`middleware.ts` still works** (deprecation warning only); keep it (rule 2).
6. **Memory.** A Turbopack build of a 200+ page app peaked near 3 GB and a webpack build near 4.5 GB: size CI runners for at least 8 GB with `--webpack`.
7. **Routes that were `● SSG` in Next 15 may print as `ƒ` (dynamic) in Next 16** when the root layout awaits `headers()` (for a CSP nonce): the whole app is then rendered per request, there is nothing to prerender or cache, and the R2 cache stays nearly empty. That is correct, but it changes what the edge cache can do; read the route table before assuming ISR.

---


## 6. The policy: `hypdriv.config.ts`

### 6.1 Production template **[verified]**

This is the shape that was built, audited and run in workerd: shared policy, one service name per Worker. Every section is optional; the reference is [configuration.md](configuration.md).

```ts
import { defineConfig } from 'hypdriv';

// Routes that machines read on purpose: exempt from the bot shield, cross-origin readable.
const MACHINE_ROUTES = [
  '/sdk/**', '/.well-known/**', '/openapi*.json', '/postman/**',
  '/AGENTS.md', '/llms*.txt', '/docs-md/**', '/learn-md/**',
];

const shared = {
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip' as const] }],
    bots: {
      likelyAutomated: 'log' as const,
      definitelyAutomated: 'block' as const,
      exempt: ['/api/**', ...MACHINE_ROUTES, '/embed/**', '/robots.txt', '/sitemap*.xml'],
    },
    headers: {
      // First matching route wins: most specific first.
      routes: [
        { match: '/embed/**', headers: { frameOptions: false as const, corp: 'cross-origin' as const } },
        { match: MACHINE_ROUTES, headers: { corp: 'cross-origin' as const } },
      ],
    },
  },
  // The edge cache answers before middleware.ts: list what the middleware gates on (rule 7).
  cache: { edge: { bypass: { cookies: ['site_gate'] } } },
  performance: { earlyHints: true, speculation: { prerender: { eagerness: 'moderate' as const, topN: 3 } } },
  observe: { tracing: { exporter: 'analytics-engine' as const }, vitals: { sink: 'analytics-engine' as const } },
  budgets: { routes: { '/**': { js: '300kb' } }, worker: { gzip: '3mb' } },
};

export function areaConfig(area: string) {
  return defineConfig({ ...shared, site: { name: `<platform>-web-${area}` } });
}
export default areaConfig('root');
```

For a single app: `export default defineConfig({ ...shared, site: { name: '<app>', origin: 'https://<host>' } })`.

### 6.2 Decisions, section by section

| Section | Decision | Why |
| --- | --- | --- |
| `site.name` | One per Worker (`<platform>-web-<area>`). | It names the service in logs, traces, Analytics Engine rows and the HUD. |
| `site.origin` | Set it for a **single-host** app. Leave it **unset** when one Worker serves several hosts (the areas of a platform serve its apex and several subdomains). | With an origin, `forceHttps: 'auto'` follows its scheme and HSTS preload advice applies. Without one, `auto` is on for every Cloudflare deployment (their edge terminates TLS). |
| `security.csp` | Defaults are strict: hash CSP on prerendered pages, nonce CSP on dynamic ones (`mode: 'auto'`). Add `allow` entries for third parties (§6.5). Never weaken `directives` to make a page pass: fix the allow list. | An app-set CSP header is left alone (`x-hypdriv-csp: app`). |
| `security.headers` | Defaults: HSTS 2 years `includeSubDomains`, COOP `same-origin-allow-popups`, CORP `same-site`, Referrer-Policy `strict-origin-when-cross-origin`, deny-by-default Permissions-Policy, `X-Frame-Options: DENY`, nosniff. Exceptions per route in `routes`. | See §6.3. **HSTS `includeSubDomains` on an apex host pins every subdomain in browsers that saw it**: all must be HTTPS-only. Otherwise set `security.headers.hsts: { includeSubDomains: false }` for that Worker. |
| `security.bots` | `definitelyAutomated: 'block'` blocks automation user agents and an empty UA on **document requests** (`Accept: text/html` / navigations); API-style requests with the same UA are only `likely` (logged). Verified crawlers (Googlebot, Bingbot, Slackbot, …) are `verified` and allowed. Exempt every machine-facing route: `exempt` **replaces** Hypdriv's default exempt list instead of extending it, so list every path that machines read. | §6.3 results. |
| `security.rateLimit` | `/api/**` per IP, Durable Object limiter (exact, global). Starting numbers (120/min) are a default, not a measurement: read the 429s in the first days and adjust. Add a tighter policy for sign-in and contact endpoints (`match: ['/api/contact', '/api/support-request', '/api/security-report', '/api/abuse-report']`, e.g. 10/min, `methods: ['POST']`). | A global exact limiter needs the `HYPDRIV_LIMITER` Durable Object (§7.1). |
| `cache.edge` | `infer: true` (default) caches static and ISR routes (5 min fresh, 1 day stale-while-revalidate). `bypass` is mandatory with a middleware (rule 7). | Tags `route:<id>`, `build:<id>`, `path:<…>` drive purges. `build:<id>` carries Next's build id, which is a constant for the app once a deployment id is set (§8.5): purging it empties the whole app's cache, not one deploy's. |
| `performance` | `earlyHints: true`, `speculation` prerender/prefetch `moderate`. | Needs a custom domain / zone route (Early Hints) and the zone's Early Hints setting on. |
| `observe` | `analytics-engine` for traces and vitals needs the `HYPDRIV_ANALYTICS` binding. Log format is JSON; the client IP is masked to /24. | `wrangler tail` and Workers Logs show request lines (service, runner, method, path, status, duration, route, cache, masked ip, requestId, traceId). |
| `budgets` | JS ≤ 300 kb per route, Worker gzip ≤ 3 mb. `hypdriv analyze` evaluates them; a breach is `warn`. | Worker size limit is 64 MiB uncompressed per Worker. |
| `jobs.cron` | Declare every cron Hypdriv should dispatch; also in `wrangler.jsonc#triggers.crons` (`doctor --fix` syncs). | Hypdriv's `scheduled` ignores other crons (rule 14, §8.7). |
| `flags`, `live`, `images`, `i18n`, `maintenance`, `redirects` | Off or default unless the app uses them. `maintenance` is the incident switch (§8.4). | Keep launch scope small. |

### 6.3 Exceptions for machine-facing and embeddable routes **[verified]**

Run in workerd against the config in §6.1 with an app that sets `frame-ancestors *` and `Access-Control-Allow-Origin: *` on `/embed/**` itself:

| Request | Result |
| --- | --- |
| `GET /embed` | 200; **no** `X-Frame-Options`; `Cross-Origin-Resource-Policy: cross-origin`; the app's `Content-Security-Policy: frame-ancestors *` and `Access-Control-Allow-Origin: *` untouched (Hypdriv leaves an app-set CSP alone). |
| `GET /sdk/v1` | 200; `Cross-Origin-Resource-Policy: cross-origin`. |
| `curl` UA + `Accept: text/html` on `/` | **403** (bot shield). |
| same on `/docs-md`, `/sdk/v1`, `/api/ping` | 200 (exempt). |
| `python-requests` UA, no `Accept: text/html`, on `/` | 200 (API-style: `likely`, logged). |

Take the route list from `next.config.ts#headers()` and the middleware. Typical entries: SDK files (`/sdk/:path*`: ACAO `*`, CORP `cross-origin`), `/.well-known/*`, OpenAPI and Postman files, `/AGENTS.md`, embeddable pages (`/embed/:path*`: `frame-ancestors *`, ACAO `*`, deliberately no `X-Frame-Options`), and agent-facing docs (`/docs-md/**`, `llms*.txt`). Extend `MACHINE_ROUTES` with whatever else the platform serves to programs.

**What else may need an exception on another platform:** OAuth callbacks and webhooks from third parties (`/api/webhooks/**` is already a default maintenance bypass path), health checks of uptime monitors (UAs containing `monitor`/`uptime` are `likely`, not blocked), and any route a partner iframes.

### 6.4 The middleware rule **[verified]**

Same workerd run, a middleware that redirects `/gated` to `/locked` unless the cookie `site_gate` is present, with `cache.edge.bypass.cookies: ['site_gate']`; and a control route gated on a cookie that is **not** listed:

| Request | `x-hypdriv-cache` | Result |
| --- | --- | --- |
| `/gated`, no cookie | MISS | 307 → `/locked` |
| `/gated`, cookie `site_gate` | **BYPASS** | 200 |
| `/gated`, no cookie, again | MISS | still 307 → `/locked` (nothing was stored for the unlocked visitor) |
| control `/gated2` with its unlisted cookie | MISS | 200, stored |
| control `/gated2`, no cookie | **HIT** | **200: the gate is bypassed** |

So: before the first deploy, read the application's `middleware.ts` (and `next.config.ts` `redirects()`/`rewrites()` with `has:` conditions) and list every cookie, header and query parameter it **decides on** for a prerendered route in `cache.edge.bypass`. Leave the gate cookie in after the gate is removed: it only costs a cache skip for visitors who still hold the cookie (7 days).

A gate that lives in a **wrapper around the Worker** (a `fetch` handler that checks a cookie or a password before calling the application) instead of in `middleware.ts` has the same problem one level up, and `cache.edge.bypass` cannot fix it: Hypdriv's edge cache would sit in front of the gate. **[verified]** on a gated site: with Hypdriv outermost (`createWorker({ app: () => import('./worker') })` around the gate), one logged-in request to a page stored it, and the next request without a cookie got the stored page (`x-hypdriv-cache: HIT`, 200). Compose Hypdriv **behind** the gate: `gate(createWorker({ next: () => import('./.open-next/worker.js'), … }))`, so a cached page is only ever served after the gate let the request through. The same goes for any wrapper that redirects, authenticates or rewrites by request: it wraps Hypdriv, not the other way round.

### 6.5 Content Security Policy

Enforce from the first deploy, behind the site gate, and use the gated window as the staging window: deploy, open every route type as an unlocked tester, read the violations, fix `allow`, then open the gate. Candidates found by scanning the source (confirm against real violations; do not paste blindly). They sit under `security.csp`; replace the `example.com` hosts with the app's own:

```ts
csp: {
  allow: {
    scripts: ['https://challenges.cloudflare.com', 'https://www.googletagmanager.com'],   // Turnstile, Google tag
    frames:  ['https://challenges.cloudflare.com'],
    styles:  ['https://cdn.example.com'],
    fonts:   ['https://cdn.example.com'],          // only if the app loads them from a CDN host
    images:  ['https://cdn.example.com', 'https://www.googletagmanager.com', 'https://*.google-analytics.com'],
    connect: ['https://api.example.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com'],
  },
},
```

Reading violations: the browser posts to `/_hypdriv/csp-report` (answered `204`). The Worker logs each one as a `csp violation` line with the fields `directive`, `blocked`, `document` and `disposition`, and writes the same to Analytics Engine (index `csp`, blob1 directive, blob2 blocked, blob3 document). `hypdriv csp suggest` reads browser-report fields, so convert the log lines while the testers browse, then ask for proposals:

```sh
npx wrangler tail <worker> --format json \
  | jq -c '.logs[]?.message[]? | fromjson? | select(.msg=="csp violation") | {effectiveDirective:.directive, blockedUri:.blocked, documentUri:.document, disposition:.disposition}' >> csp-reports.ndjson
npx hypdriv csp suggest --reports csp-reports.ndjson
```

`csp suggest` over an empty file prints "from 0 report(s)": that is not a pass, it means nothing was collected (wrong Worker, nobody opened the pages, or the filter matched nothing). `npx hypdriv csp print --route /` shows the effective policy of a route. `reportOnly: true` emits the policy as report-only; `'both'` enforces the current policy and reports a stricter one. A route that must use its own CSP sets the header itself (Hypdriv leaves it) or gets `csp.routes: [{ match, directives, mode }]`.

**Which CSP mode a page gets.** Prerendered (static) pages get a hash policy, computed at build time from the page's own inline scripts; everything else (dynamic pages, RSC payloads) gets a per-request nonce, injected into stored HTML at the edge. A dynamic route with `generateStaticParams` is hashed **page by page** (the first 25 prerendered pages of each route); a path without its own hashes (a page beyond the 25, a runtime-rendered `not-found`) gets a nonce, never another page's hashes. **[verified]** on a `trailingSlash: true` site with locale routes: browser console clean on `/`, a locale page, an article and a 404 URL. If a route misbehaves in hash mode, `security.csp.routes: [{ match: '/that/**', mode: 'nonce' }]` forces nonces for it without touching the rest. Hash mode needs rule 1: the page must be served from the populated cache, exactly as prerendered.

**Launch recommendation: `security.csp.mode: 'nonce'` for the first launch when anything can go wrong with the deploy order.** A deploy that skipped `populateCache` (`wrangler deploy --config <file>` or `wrangler versions upload` on their own) makes hash mode block every inline script on every prerendered page: the pages render but do not hydrate, and `doctor` cannot see it. Nonce mode blocked nothing in the same test, at a cost of about 0.6 ms first-byte time locally. Moving to `auto` later is one deleted line. A platform whose deploy path runs `populateCache` as an enforced gate (rule 1) may start with `auto`.

**An app that sets its own CSP** (a nonce policy from `middleware.ts`) keeps it: Hypdriv sees a `Content-Security-Policy` that is not its own, answers `x-hypdriv-csp: app` and adds nothing. Consequences: `security.csp.reportOnly: true` does nothing for that app (there is no Hypdriv policy to report), so the report-only rollout cannot observe it, and `security.csp.allow` is inert, a safety net if the middleware CSP is ever removed. To hand CSP to Hypdriv later, remove the CSP from the middleware (keep reading the nonce in the root layout: Hypdriv's default `nonceHeader` is also `x-nonce`), roll out with `reportOnly: true` first and read `/_hypdriv/csp-report` before enforcing. Not expressible in Hypdriv: an origin the middleware adds only for some visitors (a staff cookie), and the app's own `base-uri 'none'` / `frame-ancestors 'none'` (override with `directives`).

---

## 7. Cloudflare infrastructure

### 7.1 Inventory per Worker

| Resource | Binding | Created by | Needed for | Shared across a platform's Workers? |
| --- | --- | --- | --- | --- |
| R2 bucket `<platform>-opennext-cache` (hint `enam`) | `NEXT_INC_CACHE_R2_BUCKET` + var `NEXT_INC_CACHE_R2_PREFIX` | `wrangler r2 bucket create` | prerendered pages, ISR, data cache (rule 1) | **yes**, one bucket, prefix `"<area>/"` per Worker **[verified]** |
| Service binding to itself | `WORKER_SELF_REFERENCE` | wrangler config | ISR revalidation requests | per Worker (its own name) |
| Durable Object classes `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge` | `NEXT_CACHE_DO_QUEUE`, `NEXT_TAG_CACHE_DO_SHARDED`, `NEXT_CACHE_DO_PURGE` | migration `opennext-v1` | ISR queue, tag cache, batched zone purges | per Worker (a DO namespace belongs to its script) |
| Durable Object classes `HypDrivChannel`, `HypDrivLimiter`, `HypDrivIndex` | `HYPDRIV_CHANNEL`, `HYPDRIV_LIMITER`, `HYPDRIV_INDEX` | migration `hypdriv-v1` | live channels, exact rate limits, exact tag-purge index | per Worker |
| KV namespace `<platform>-hypdriv-kv` | `HYPDRIV_KV` | `wrangler kv namespace create` | global cache tier, redirects, maintenance flag, flags | one per platform, shared by its Workers **[first deploy]**: shared maintenance/redirect/flag switches are intended; confirm with the purge probe (§11) |
| Analytics Engine dataset `<platform>_hypdriv` | `HYPDRIV_ANALYTICS` | declared in wrangler (enable the product once per account) | traces, Web Vitals, CSP reports | one per platform; `site.name` tells the Workers apart |
| Rate Limiting namespace | `HYPDRIV_RATE_LIMIT` | declared in wrangler | optional `store: 'binding'` policies | **unique `namespace_id` per Worker** (rule 15) |
| Secrets | see §7.3 | `wrangler secret put` | | |
| Cron triggers | `triggers.crons` | wrangler config | `jobs.cron` | only where declared |

### 7.2 Provisioning (US-first)

```sh
# R2 (location hint is honored only at creation)
npx wrangler r2 bucket create <platform>-opennext-cache --location enam

# KV (copy the id into every Worker's kv_namespaces entry)
npx wrangler kv namespace create <platform>-hypdriv-kv
```

**No time-based lifecycle rule on the cache bucket.** An expiry rule counts from the object's last write; a site that is not redeployed for the rule's period would lose its current build's prerenders and fall into rule 1 (every hash-CSP page rendered per request). Old builds' entries are small. Prune by deployment id once the bucket grows (keys are `<prefix><deploymentId>/…`; the live one is the `deployment` field of `/_hypdriv/health`), always keeping the current and the previous deployment's prefix.

Durable Objects, the Analytics Engine dataset and rate-limit namespaces come into existence with the first `wrangler deploy` of the Worker that declares them. Enable Analytics Engine once in the dashboard first (until then the deploy fails with an error naming Analytics Engine).

`ratelimits` namespace allocation (positive integers as strings, unique per Cloudflare account; check `grep -rh namespace_id` over every wrangler file of the account before choosing): reserve a block per platform, e.g. `1101`–`1108` for the eight areas of the first platform, `1201`–`1208` for the second, and so on in blocks of 100. Record the allocation next to the infra scripts.

A fleet creates its resources through its provisioning script, which reads the plan and writes the ids; see §9.

### 7.3 Secrets

| Secret | Where | Value |
| --- | --- | --- |
| `HYPDRIV_SESSION_SECRET` | every Hypdriv Worker | ≥ 32 random bytes; one value per platform so a signed value verifies on any of its Workers |
| `HYPDRIV_INTERNAL_SECRET` | every Hypdriv Worker | ≥ 32 random bytes; signs Hypdriv's internal requests (HMAC over timestamp, method, path, body hash; 5-minute window) and is the key of the short-lived tokens of `hypdriv audit`, `warm` and `purge`; one per platform |
| `CACHE_PURGE_ZONE_ID` | every Worker that purges | zone id of the served zone (not a secret in the cryptographic sense, but keep it with the token) |
| `CACHE_PURGE_API_TOKEN` | same | token limited to Zone → Cache Purge on that one zone |
| `OTLP_HEADERS` | only with the OTLP exporter | exporter auth header |
| Turnstile secret | only with `bots` challenge actions | per the Turnstile widget |

`wrangler secret put <NAME> --name <worker>` reads stdin. Generate with `openssl rand -base64 48`. Secrets live in the platform's escrow (a git-ignored file or a secrets manager read by the deploy script, never printed). Rotation: put the new value on all Workers of the platform in one window; the 5-minute signature window makes a short mismatch fail closed. Hypdriv's secrets scan fails the build if a non-public env value appears in client assets; `NEXT_DEPLOYMENT_ID` is public by design and skipped.

### 7.4 Zone, DNS and routing

- **Attach hosts as custom domains or zone routes**, never `workers.dev` (rule 9). Both give the Worker the zone (Cache API, Early Hints, zone purge, image resizing). A zone shared with other projects needs zone routes with exact patterns when another Worker owns part of a host. Never attach a host the platform does not own.
- **HTTPS redirection (rule 8).** First check what the zone does today: `curl -sI http://<host>/` must answer `301`/`308` to `https://` from Cloudflare *and* for an asset path `http://<host>/_next/static/…`. If it does not, enable **Always Use HTTPS** on the zone, or on a shared zone add a Redirect Rule scoped to the platform's hostnames (`http.host in {"…"}` and `ssl = false` → `https://` same URL, 308). Do not flip a zone-wide setting on a shared zone without confirming the other projects' hosts serve HTTPS. Verify with `npx hypdriv audit https --url https://<host>`.
- **Geo.** Country rules for flags and `vary.geo` read `request.cf`; when a router forwards through a service binding and `cf` is missing, Hypdriv falls back to `cf-ipcountry` (IP Geolocation, on by default under Network). Optional: the managed transform "Add visitor location headers".
- **Early Hints** on (Speed → Optimization) if you use `performance.earlyHints`.
- **Do not add zone Cache Rules or Page Rules that cache HTML** for these hosts: Hypdriv owns HTML caching, with tags and purges.
- **WAF.** Keep the zone's WAF and managed rules; Hypdriv's bot shield is application-level, not a replacement.

### 7.5 What the plan must include

Workers **Paid**. A fleet with eight Workers uses Durable Objects (6 classes each), KV, R2, Analytics Engine and subrequests (Cache API ≤ 1,000 per request, Hypdriv uses at most one read and one write).

---

## 8. Build, populate, deploy

### 8.1 The sequence (single Worker)

```sh
npm ci                                                       # lock file pins the tarballs
npx opennextjs-cloudflare build                              # next build + OpenNext bundle (+ .hypdriv/manifest.*)
npx hypdriv analyze                                          # Worker size + budgets (warnings unless budgets.failOn is 'error'); doctor needs it
npx hypdriv doctor --ci                                      # gate: 0 failed checks (includes the size checks analyze fed)
npx opennextjs-cloudflare populateCache remote --config wrangler.jsonc   # rule 1: R2 gets this build's prerenders FIRST
npx wrangler deploy --config wrangler.jsonc                  # DO migrations apply here (rule 16)
npx hypdriv audit all --url https://<host>                   # gate: headers, CSP, cache, https
```

`opennextjs-cloudflare deploy` = populate + `wrangler deploy` in one step for a single app (`--config` and `--env` supported). Use it (or the two explicit steps above) for any app whose pages are prerendered: a deploy without populate is the failure of rule 1. What skips the populate step is `wrangler deploy --config <file>` on its own, `wrangler deploy --dry-run`, `wrangler versions upload`, or a directory without `open-next.config.*`; a bare `wrangler deploy` without `--config` inside an OpenNext project is handed to `opennextjs-cloudflare deploy` by wrangler and does populate, but a deploy script should not depend on that. For an app with Wrangler environments run it once per environment (`--env <name>`), after `hypdriv doctor --env <name>` and `hypdriv analyze --env <name>` for the same one. A fleet runs the two explicitly per area (§9.2) because it deploys with its own config files.

Credentials: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. `populateCache remote` writes to R2 through the API.

### 8.2 CI

Same sequence in CI on Node 22.18+; cache `~/.npm` only; no secrets in logs; run the audit against the deployed URL with the gateway headers the zone requires (`HYPDRIV_ACCESS_HEADERS`, `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`, or `--header`). `hypdriv doctor --ci --json` is machine-readable and exits 1 on any failure.

### 8.3 After the deploy

- `npx hypdriv warm --url https://<host>` fills the edge cache for `cache.warm.routes` or every static/ISR route. It fetches pages like a visitor, so **while a site gate is closed it warms nothing**: anonymous requests get the gate's redirect, and a request that carries the gate cookie is a cache `BYPASS`, yet the command still prints "N/N warmed". Run it after the gate opens and read the cache column: `MISS` on the first pass, `HIT` on the second.
- `GET /_hypdriv/health` → `{"ok":true,"service":"<site.name>","hypdriv":"0.1.0","build":"<content fingerprint>","deployment":"<commit-or-build>-<stamp>","framework":"Next.js 16.4.3","next":"16.4.3","runner":"worker","target":"cloudflare","routes":N,"capabilities":[…]}`. `runner` must be `worker` and `target` `cloudflare`; `capabilities` lists the bindings Hypdriv found (tiered cache with KV, exact tag purge, exact rate limiting, live channels). `build` is the content fingerprint that scopes edge-cache keys; `deployment` is the id that scopes the R2 keys (§8.5).
- `npx wrangler tail <worker> --format json` for the first minutes (§11 probes).

### 8.4 Rollback

| Situation | Action |
| --- | --- |
| A deploy misbehaves | `npx wrangler rollback [version-id] --config <wrangler file> -y` (previous version; without `-y` it prompts). R2 keys are scoped by the deployment id and edge-cache keys by the content fingerprint, both embedded in that version's own manifest, so the previous version finds the entries it populated (they stay in the bucket, §7.2) and the edge-cache entries that have not expired. |
| One feature of Hypdriv misbehaves | set the config switch and redeploy: `stages.disable: ['<stage>']`, `security.csp.mode: 'nonce'` (hash CSP trouble), `cache.edge: false` (cache trouble), `security.rateLimit: []`, `security.bots: false`. |
| A bad page is cached | `npx hypdriv purge --url https://<host> --path /… ` (or `--tag route:<id>`, or `--all`): a signed request to the Worker that clears **every** tier (memory, Cache API, KV) and the zone copies when `CACHE_PURGE_*` is set (needs `HYPDRIV_INTERNAL_SECRET` locally; a gate in front needs `--header`). The other recovery is a fresh build and deploy: a new build has a new deployment id, which changes every edge-cache key. **Do not use a raw Cloudflare purge by tag as the fix**: it clears the Cache API copies only, and the KV copy (about 8 days) refills them. `--all` is the tag `build:<id>`; Next.js uses one constant build id for every build once a deployment id is set, so it covers the whole app, and a raw zone purge of it would hit every Hypdriv app on the zone. A fleet's `/_hypdriv/**` is answered by one area (`site`) only, so `purge` reaches that area; for another area redeploy it. A purge keeps those tags uncached for 5 seconds (`purgeGraceMs`). |
| Incident, serve a maintenance page | `echo 1 | npx wrangler secret put HYPDRIV_MAINTENANCE --name <worker>` on each Worker (`1`, `true`, `on` and `yes` enable it; `0`, `false`, `off`, `no` and an empty value disable it; any other non-empty text enables it and becomes the message shown to visitors; end it with `npx wrangler secret delete HYPDRIV_MAINTENANCE --name <worker>`, which asks for confirmation). `maintenance.allowIps`, `bypassCookie` and `bypassPaths` (default `/_hypdriv/**`, `/api/webhooks/**`) keep operators and webhooks working. A shared KV switch needs `maintenance: { kvBinding: 'HYPDRIV_KV' }` in the config beforehand **[first deploy]**. |
| Full removal of Hypdriv from one Worker | point `wrangler.jsonc#main` back to `.open-next/worker.js` and redeploy; `next.config.ts` can stay wrapped. |

Durable Object migrations are append-only: a rollback never removes classes.

### 8.5 Deployment ids

Hypdriv sets a per-build deployment id (`<commit-or-"build">-<base36 stamp>`, ADR 0016; the `deployment` field of `/_hypdriv/health`). It scopes the R2 keys and, through the manifest's content fingerprint (`build` in the health response), every edge-cache key, so each build starts with an empty edge cache. Next.js does **not** derive its build id from it: once a `deploymentId` is set Next.js uses one constant build id (`build-TfctsWXpff2fKS`) for every build, which is why the cache tag `build:<id>` covers the whole app (§8.4). Three different ids, then: Next's constant build id (tag `build:<id>`), Hypdriv's deployment id (R2 keys, `deployment`) and the content fingerprint (edge-cache keys, the `x-hypdriv-build` header of HTML responses, `build` in the health response). Do not set `deploymentId` yourself (rule 13). `performance.skewProtection` is on by default.

### 8.6 Daily dependency maintenance

`npx hypdriv deps` reports outdated packages across the app (also run daily by the Hypdriv repository's workflow). Apply patch/minor updates automatically; report majors with a migration proposal. Hypdriv itself updates only through a new release bundle (§4).

### 8.7 Cron and queues

Hypdriv's `scheduled` handler dispatches only the crons in `jobs.cron` and ignores the rest. If the Worker already had a `scheduled` handler (or `queue`/`email`), compose explicitly in `hypdriv.worker.ts`:

```ts
const hyp = createWorker({ config, next: () => import('./.open-next/worker.js'), manifest: () => import('./.hypdriv/manifest.js') });
export default {
  ...hyp,
  async scheduled(controller: ScheduledController, env: unknown, ctx: ExecutionContext) {
    await hyp.scheduled?.(controller, env as never, ctx);
    await appScheduled(controller, env, ctx);   // the platform's existing handler
  },
};
```

**[first deploy]** (the shape type-checks against `createWorker`'s return type; no platform in the current fleet needs it, because the web Workers have no cron). Cron expressions must be declared in `triggers.crons` too; `doctor --fix` syncs them.

---

## 9. A fleet of Workers behind a router

Some platforms are not one Next app. The site is split into several Next projects ("areas"), each built and deployed as its own Worker, behind one **router Worker** that picks the area by host and path and forwards the original request over a service binding. Hypdriv goes into every area Worker; the router needs none. Everything in §1–§8 applies per area. This section is what changes, what a build/deploy generator must write for each area, and what the shape does to the probes.

```
Browser → Cloudflare zone → router Worker       (static assets of every area merged; routes by host and path; no Hypdriv)
             → service binding, the original Request forwarded untouched
               → area Worker  <platform>-web-<area>     ← Hypdriv sits here (hypdriv.worker.ts)
```

### 9.1 What the shape changes

- **The deployable Wrangler config of an area is usually not the file in its project directory.** A generator writes one config per Worker (`infra/<worker>.wrangler.jsonc`) whose `main` points into the area directory (`../.areas/<area>/hypdriv.worker.ts`), next to a build-only config that OpenNext reads. Wrangler resolves `main` and `assets.directory` against the config file. Hypdriv's CLI accepts that pair: `hypdriv doctor --root <area dir> --wrangler <deployable config>` (`HYPDRIV_WRANGLER_CONFIG` does the same for every command), and `opennextjs-cloudflare populateCache remote --config <deployable config>` is run from the area directory. **[verified]**: `wrangler deploy --dry-run` of such a config accepted all 11 Hypdriv and OpenNext bindings (6 Durable Objects, KV, R2, the self service binding, Analytics Engine, Rate Limiting) next to `ASSETS`, and the doctor passed `wrangler.main`, `wrangler.assets`, `wrangler.self-reference`, `opennext.cache` and `cache.middleware` for it.
- **`/_hypdriv/**` lands in the router's default area.** `GET /_hypdriv/health`, the CSP report endpoint and the vitals ingest are answered by whichever area the router sends unknown first path segments to. You cannot read another area's health endpoint through the router, and `hypdriv purge` reaches that one area only (probe 12); prove an area with the response headers of one of its own pages (probe 5).
- **Per-Worker resources stay per Worker; some are shared on purpose.** Durable Objects, the self service binding and the Rate Limiting namespace belong to one Worker. One R2 bucket (a key prefix per area), one KV namespace and one Analytics Engine dataset serve the whole platform (§7.1).
- **The client address and `request.cf` must survive the router.** The address travels in `cf-connecting-ip` (probe 6); geo falls back to `cf-ipcountry` when `cf` is missing (§7.4).
- **The staging window has no zone** (§9.5).

### 9.2 What the generator must write for every area Worker

1. **In the area project** (the generator's per-area preparation step): `next.config.ts` that imports the platform's root config and exports `withHypDriv(config)`; a generated `hypdriv.config.ts` that calls the shared policy's `areaConfig('<area>')` (import with the `.ts` extension, rule 3); `hypdriv.worker.ts` (§5.5) and `instrumentation.ts`; the production `open-next.config.ts` (§5.4) for **every** area (the root app's own `open-next.config.ts` may be a different, empty one: keep a separate file for the areas); `allowImportingTsExtensions` in the area `tsconfig.json` and `hypdriv.worker.ts` excluded from it.
2. **In the deployable Wrangler config of the area:** `main` → the area's `hypdriv.worker.ts`; `WORKER_SELF_REFERENCE` → the Worker's own name; `NEXT_INC_CACHE_R2_BUCKET` → the shared bucket (location hint `enam`) and var `NEXT_INC_CACHE_R2_PREFIX = "<area>/"`; `HYPDRIV_KV` → the shared namespace; the six Durable Object bindings and the append-only migrations `opennext-v1` and `hypdriv-v1`; `HYPDRIV_ANALYTICS` → the shared dataset; `HYPDRIV_RATE_LIMIT` with a `namespace_id` unique in the account (rule 15; a block per platform, position of the area added); `workers_dev: false`.
3. **After each area build:** require a fresh `.hypdriv/manifest.js` (older than the build ⇒ `withHypDriv` is not wrapping the config) and run `hypdriv doctor --ci --root <area dir> --wrangler <deployable config>`; a failed check stops the build.
4. **At deploy, per area, in the area directory:** `opennextjs-cloudflare populateCache remote --config <deployable config>` **before** `wrangler deploy`; if it fails, that Worker is not deployed (rule 1). The router is deployed last, because it binds the areas.
5. **Secrets:** `HYPDRIV_SESSION_SECRET` and `HYPDRIV_INTERNAL_SECRET` generated once per platform (one value for all its areas, so a signed value verifies on any of them), kept in the platform's escrow and set on every area Worker; `CACHE_PURGE_ZONE_ID` and `CACHE_PURGE_API_TOKEN` provided by the operator. The generator reports a secret name with no value and skips it; it never prints a value.

### 9.3 One shared policy

Keep one `hypdriv.config.ts` at the repository root with the policy of §6.1 and `areaConfig(area)`, which only changes `site.name` (`<platform>-web-<area>`). A change to it needs a rebuild of **every** area (the policy is compiled into each manifest). Review it before the first build:

1. **Gate cookies** in `cache.edge.bypass` (rule 7): every cookie, header and query parameter the middleware decides on for a prerendered route.
2. **Machine-facing routes** (§6.3), **embeds**, **rate limits** (starting values, not measurements), **CSP allow-list** (§6.5), and the **HSTS decision**: the default is `includeSubDomains` for two years; on an apex shared with other projects confirm every subdomain is HTTPS-only or turn it off (§6.2).
3. **`site.origin` stays unset** when one Worker serves several hosts.

### 9.4 Order of operations

1. Install Hypdriv into the repository (§4); apply the generator changes (§9.2); review the diff.
2. Create the two Hypdriv secrets in the escrow; the purge pair by hand.
3. Generate the Wrangler configs and the plan; provision (dry run first: expect exactly the KV namespace and the R2 bucket); generate again so the ids land in the configs. Check the Rate Limiting namespace ids for duplicates across **all** wrangler files of the account.
4. Build every area (manifest check and doctor per area), then merge the router's assets.
5. Validate every config without side effects (`wrangler deploy --dry-run` per config).
6. **Staging deploy** (no zone, `workers.dev`): probes that work there (§9.5).
7. **Cutover:** attach hosts / zone routes; probes that need the zone.
8. Open the gate (§12).

### 9.5 What the staging window proves and what it cannot

The staging deploy answers on `*.workers.dev`, where **the Cache API is a no-op** (rule 9):

| Provable on staging | Needs the zone |
| --- | --- |
| Bindings and Durable Object migrations apply (rule 16); secrets are set; `populateCache` worked (a hash-CSP page hydrates); headers, CSP, bot shield, the Durable Object rate limiter, gate behaviour, the maintenance switch, `x-hypdriv-*` headers per area, Analytics Engine rows | `x-hypdriv-cache: HIT` (edge cache), Early Hints, the zone copies of a purge, `request.cf`-based geo, HTTPS redirect of the zone (rule 8) |

Do not skip the cutover probes: the edge cache is the part of Hypdriv that only exists on the zone.

### 9.6 Plain Workers and back-office apps in the same account

API gateways, queue consumers and other plain Workers keep running as they are: Hypdriv has no integration for them. Single back-office Next apps (admin consoles, control planes) follow §5 on their own schedule; check them with `hypdriv doctor` first (`compat.node-apis` flags Node APIs that do not run on Workers, such as native database clients) and do not put them into a launch window that was not rehearsed for them.

---

## 10. Platform notes

Hosts, script names, resource names, decision records and per-platform deltas of the platforms that use this guide (their gate cookies, route lists, zone constraints, the exact generator patch) are kept outside this repository, in the private release bundle next to this guide: `PLATFORMS.md`. Read it together with this guide when you work on one of those platforms. A platform not listed there follows §5 (one app) or §9 (a fleet) as written.


---

## 11. First-deploy probes

Everything marked **[first deploy]** has exactly one probe here. Run them in this order; each says where it can run (**S** = staging on `workers.dev`, **Z** = on the zone after the cutover) and what to do if it fails. Replace `$BASE` with the host under test. Use a browser user agent in `curl` (`-A "$UA"`), because the bot shield blocks automation user agents on document requests (rule 11); `UA='Mozilla/5.0 (X11; Linux x86_64) Chrome/130'`.

The expected outputs below were captured from the local workerd run of the simulation, with the same configuration.

**Probe 1 · Hypdriv answers, bindings found (S, Z).** For a fleet this reaches the `site` area only (§9.1).

```sh
curl -s "$BASE/_hypdriv/health"
# {"ok":true,"service":"<prefix>-web-site","hypdriv":"0.1.0","build":"<content fingerprint>","deployment":"<commit-or-build>-<stamp>","framework":"Next.js 16.4.3","next":"16.4.3",
#  "runner":"worker","target":"cloudflare","routes":N,"capabilities":["cache: tiered (memory → Cache API → KV)","tag purge: exact (Durable Object index)",
#  "rate limiting: exact (Durable Object)","config store: Workers KV","live channels: Durable Object (SSE/WebSocket)","vitals/traces sink: Analytics Engine", …]}
```

`runner` must be `worker`. Every capability line is always printed, with fallback text when the binding is missing, so read the text: `cache: Cache API (per colo)` or `memory (per isolate)` instead of `tiered … KV` ⇒ `HYPDRIV_KV` is missing; `tag purge: KV index` or `TTL/SWR bounded` ⇒ the `HYPDRIV_INDEX` Durable Object; `rate limiting: approximate` or `per isolate` ⇒ `HYPDRIV_LIMITER`; `config store: none` ⇒ KV; `live channels: polling fallback` ⇒ `HYPDRIV_CHANNEL`; `vitals/traces sink: logs` ⇒ Analytics Engine (`HYPDRIV_ANALYTICS`). `build` is the content fingerprint and `deployment` the deployment id (§8.5). Compare with the generated `web-site.wrangler.jsonc`, then `wrangler deploy` that Worker again.

**Probe 2 · The R2 cache was populated before traffic, a hash-CSP page hydrates (S, Z).** Rule 1.

```sh
curl -s -D - -o /dev/null -H 'Accept: text/html' -A "$UA" "$BASE/" | grep -i -E '^(HTTP|content-security-policy|x-hypdriv-csp|x-nextjs-cache|x-nextjs-prerender)'
npx hypdriv audit csp --url "$BASE" --header "Cookie: site_gate=$GATE_COOKIE"      # prerendered pages: script hashes cover every inline script
```

Expect `x-hypdriv-csp: hash` on prerendered pages, and a policy with `'sha256-…'` entries (with the launch setting `security.csp.mode: 'nonce'` of §6.5: `x-hypdriv-csp: nonce` and a `'nonce-…'` policy; an app that owns its CSP: `x-hypdriv-csp: app`). Then open the page in a real browser as an unlocked tester with the console open: it must hydrate (interactive controls work) and the console must show **no** `Executing inline script violates … script-src` error. If the page loads but is dead: `populateCache` did not run for this build (check the deploy log of the area), or ran against another bucket/prefix. Recovery without a new build: run `populateCache remote` again for this build, then `npx hypdriv purge --url "$BASE" --all` (probe 12) so the broken HTML leaves every cache tier (a raw Cloudflare tag purge is not enough); break-glass `security.csp.mode: 'nonce'` and redeploy.

**Probe 3 · Edge cache MISS → HIT (Z only).** The Cache API is a no-op on `workers.dev`. Run it on a prerendered route the site gate lets through, or after the gate opens (§12). Behind a closed gate an anonymous request is answered by the middleware (a `307` with `MISS`, never stored) and a request that carries the gate cookie is a `BYPASS`, so no `HIT` can be shown.

```sh
for i in 1 2 3; do curl -s -o /dev/null -D - -H 'Accept: text/html' -A "$UA" "$BASE/" | grep -i -E '^(HTTP|x-hypdriv-cache|age)' | tr '\r\n' ' '; echo; done
# HTTP/2 200  x-hypdriv-cache: MISS   →   HTTP/2 200  age: 3  x-hypdriv-cache: HIT   →   … HIT
```

First request `MISS`, then `HIT` with a growing `age`. The other values: `MISS` on every request means the response is not cacheable (`cache-control: private` or `no-store`, a `Set-Cookie`, or a `Vary` the policy cannot key); `BYPASS` means the request carries a `cache.edge.bypass` cookie, header or query parameter (one that every visitor carries makes the whole route uncacheable), an `Authorization` header, or the policy has a zero TTL; `DYNAMIC` means no cache policy matches the route, the method is not GET, or `cache.edge` is off. `npx hypdriv routes` shows the classification; `npx hypdriv audit cache --url "$BASE"` explains per route.

**Probe 4 · The site gate holds behind the cache (S, Z).** Rule 7, §6.4. As an unlocked tester (a valid gate cookie) request a prerendered page, then request the same page anonymously.

```sh
curl -s -o /dev/null -D - -H 'Accept: text/html' -A "$UA" -H "Cookie: site_gate=$GATE_COOKIE" "$BASE/<a gated page>" | grep -i -E '^(HTTP|x-hypdriv-cache)'   # 200, BYPASS
curl -s -o /dev/null -D - -H 'Accept: text/html' -A "$UA" "$BASE/<a gated page>" | grep -i -E '^(HTTP|location|x-hypdriv-cache)'                 # 307 → the gate, never HIT with 200
```

Anything but a redirect to the gate for the anonymous request is a launch blocker: the middleware gates on something that is not in `cache.edge.bypass`. Add it and rebuild every area.

**Probe 5 · Every area is Hypdriv-fronted and routed correctly (S, Z).** Fleet only. One path per area; the router names the area in a response header (`x-<platform>-area` in `PLATFORMS.md`), Hypdriv puts `x-hypdriv-request-id` on every response, a redirect included, and `x-hypdriv-build` on HTML responses only.

```sh
for p in <one path per area, plus a public API path>; do
  printf '%-28s' "$p"; curl -s -o /dev/null -D - -H 'Accept: text/html' -A "$UA" "$BASE$p" | tr -d '\r' | grep -i -E '^(HTTP|x-[a-z]+-area|x-hypdriv-build|x-hypdriv-request-id)' | tr '\n' ' '; echo
done
```

Expect, for each line, the right area in the router's area header (the routing table is in the router's source, listed in `PLATFORMS.md`) **and**, on HTML pages, an `x-hypdriv-build` that differs between areas (every area is its own build; the value is the content fingerprint of that area's manifest; a JSON or other non-HTML response has none). A line without `x-hypdriv-request-id` means that area Worker is not running `hypdriv.worker.ts`: its deployed `main` is wrong (`npx wrangler deployments list --name <worker>`; compare with the generated config).

**Probe 6 · Client IP survives router → area (S, Z).** Rate limits and logs are keyed by the client address, which travels in `cf-connecting-ip`.

```sh
npx wrangler tail <area worker> --format json \
  | jq -r '.logs[]?.message[]? | fromjson? | select(.msg=="request") | "\(.method) \(.path) \(.status) ip=\(.ip)"'     # then request any page from your machine
# an IPv4 client shows as a.b.c.0 (last octet zeroed), e.g. ip=203.0.113.0; an IPv6 client as its first four groups plus ::
```

Your own /24 (or /64 for IPv6) is correct. An empty `ip`, or one that is the same for every visitor (a Cloudflare address), means the client address is lost between the router and the area: set `security.rateLimit[].key` to a header that survives, or forward `cf-connecting-ip` explicitly in the router, and do not rely on IP limits until fixed. Geo: Hypdriv reads `request.cf` and falls back to `cf-ipcountry`; if the platform uses country rules or `vary.geo`, check that a request from a known country reaches the rule.

**Probe 7 · Rate limiter (S, Z).** Use a cheap public endpoint of the `api` area, not a state-changing one. 140 requests from one connection in a few seconds:

```sh
for i in $(seq 1 140); do curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" "$BASE/api/<cheap endpoint>"; done | sort | uniq -c
#  ~120 × 200, then 429 for the rest of the minute (the 429 carries Retry-After, ratelimit, ratelimit-policy: "api";q=120;w=60 and x-ratelimit-*; the simulation answered 121 × 200 and 19 × 429)
```

Counts are per client address and per area Worker (the limiter Durable Object is per Worker). All 200: the limiter is not running (`HYPDRIV_LIMITER` binding or `security.rateLimit` missing), or the address is not stable between requests (CI egress can rotate it: use one keep-alive connection). 429 immediately and always: the key is the same for everyone (probe 6).

**Probe 8 · Bot shield and its exceptions (S, Z).**

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' "$BASE/"                    # 403: curl user agent on a document request
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' "$BASE/docs-md/<a page>"    # 200: machine route, exempt
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/llms.txt"                                   # 200 (and every route in MACHINE_ROUTES that exists)
```

A legitimate client that gets 403: add its route to `security.bots.exempt` (rule 11). Uptime monitors with `monitor`/`uptime` in their user agent are only logged.

**Probe 9 · CSP as an unlocked tester, every route type (S, Z).** §6.5. Open each type of page (marketing, docs, a form with Turnstile, dashboard, wallet, an embed) in a browser with the console open while `wrangler tail <worker> --format json` runs for the area. Violations arrive at `/_hypdriv/csp-report` (a `204`) and appear as `csp violation` log lines and in Analytics Engine. Convert the log lines to the report format as in §6.5 (the `jq` filter that selects `.msg=="csp violation"`) into `csp-reports.ndjson`, then run:

```sh
npx hypdriv csp suggest --reports csp-reports.ndjson     # allow-list proposals
npx hypdriv csp print --route /                           # the effective policy of a route
```

"From 0 report(s)" is not a pass: it means nothing was collected. Zero violations on every route type, from a non-empty browsing session, before the gate opens (§12). Third parties found in reports are added to `security.csp.allow` in the root policy, and every area is rebuilt.

**Probe 10 · HTTPS enforcement (Z).** Rule 8.

```sh
curl -sI "http://<host>/"                                  # 301/308 → https://<host>/
curl -sI "http://<host>/_next/static/<a hashed asset>"     # the same: assets are answered before the Worker
npx hypdriv audit https --url "https://<host>"
```

**Probe 11 · Analytics Engine receives rows (S, Z).** Browse a few pages, then (token with *Account Analytics: Read*, account id in the environment; nothing printed):

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data "SELECT blob1, count() AS n FROM <dataset> GROUP BY blob1 ORDER BY n DESC LIMIT 10"   # blob1: span name (traces), metric name (vitals), violated directive (CSP reports)
```

Rows within a minute or two. None: `HYPDRIV_ANALYTICS` is not bound, the dataset name differs from `observe`'s binding, or Analytics Engine was not enabled for the account.

**Probe 12 · Purge reaches every cache tier (Z).** Needs `HYPDRIV_INTERNAL_SECRET` in the environment of the command (and `CACHE_PURGE_ZONE_ID` + `CACHE_PURGE_API_TOKEN` on the Worker, so the copies other colos hold are purged too). Pick a cached page of the area that answers `/_hypdriv/**` (for a fleet, the `site` area: §9.1) that shows `HIT` (probe 3), purge it, request again:

```sh
curl -s "$BASE/" -o /dev/null -D - -A "$UA" -H 'Accept: text/html' | grep -i -E '^(cache-tag|x-hypdriv-cache)'   # route:…,path:/,build:build-…   HIT
npx hypdriv purge --url "$BASE" --path /                                  # add --header "Cookie: …" behind a gate; exit 0, "Purged 0 tag(s) and 1 URL(s)"
curl -s -o /dev/null -D - -A "$UA" -H 'Accept: text/html' "$BASE/" | grep -i '^x-hypdriv-cache'                  # MISS
sleep 6; curl -s -o /dev/null -D - -A "$UA" -H 'Accept: text/html' "$BASE/" | grep -i '^x-hypdriv-cache'         # MISS (stored again), then HIT
```

For five seconds after a purge the purged tags are served but not stored (`purgeGraceMs`: Next.js applies a revalidation after the purge returns), so the page is `MISS` until then and cached again by the first request after the window. `hypdriv purge` exits `1` with the reason when the endpoint answers `404` (the Worker has no `HYPDRIV_INTERNAL_SECRET`, or a different one, or predates the command), `409` (no edge cache), or a gateway answers instead.

**Why not Cloudflare's purge API as the fix:** `POST /zones/<id>/purge_cache {"tags":["path:/"]}` removes the Cache API copies only. Hypdriv's store is memory → Cache API → KV, and a hit in a lower tier refills the upper ones, so with `HYPDRIV_KV` bound the page returns as a `HIT` right after the zone purge and the KV copy stays for about 8 days. The purge that clears everything runs inside the Worker: `hypdriv purge`, or `purgeEdge()` / `revalidateTag()` / `revalidatePath()` from application code. If the endpoint cannot be reached (another fleet area, a Worker older than this bundle), the recovery is a fresh build and deploy: a new deployment id changes every edge-cache key.

**Probe 13 · Maintenance switch (S, on one non-critical area).** Rule of §8.4.

```sh
echo 1 | npx wrangler secret put HYPDRIV_MAINTENANCE --name <area worker>      # a new version deploys by itself
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" -H 'Accept: text/html' "$BASE/<a page of that area>"  # 503 maintenance page
npx wrangler secret delete HYPDRIV_MAINTENANCE --name <area worker>
```

`/_hypdriv/**` and `/api/webhooks/**` stay reachable during maintenance. A 200 means the switch is not in effect: the secret name is misspelled, it was set on another Worker, the new version has not finished deploying, the value is `0`, `false`, `off`, `no` or empty, or the request is exempt (`maintenance.bypassPaths`, `allowIps` or the bypass cookie). `wrangler secret delete` asks for confirmation (answer `y`); `1`, `true`, `on` and `yes` enable the switch, and any other non-empty text enables it and becomes the message.

**Probe 14 · Rollback drill (S).** On staging, deploy a trivially changed build of one area, then `npx wrangler rollback --config infra/<worker>.wrangler.jsonc -y`, and check probes 1–3 for the restored build: the `build` and `deployment` fields of `/_hypdriv/health` (and `x-hypdriv-build` on HTML responses) return to the previous values. Do this once before the launch so nobody meets the command for the first time during an incident.

**Probe 15 · The full audit (Z).** Put `HYPDRIV_INTERNAL_SECRET` into the environment of the shell for these commands only (read it from the escrow; never paste it into a shell history). `audit` requests carry a short-lived token signed with it, so the shield and the rate limiter let them through. The site gate decides how to run it:

```sh
# While the gate is closed: each audit needs the request a visitor would make
npx hypdriv audit headers --url "https://<host>" --header "Cookie: site_gate=$GATE_COOKIE"
npx hypdriv audit csp     --url "https://<host>" --header "Cookie: site_gate=$GATE_COOKIE"
npx hypdriv audit https   --url "https://<host>"                                         # anonymous by design
npx hypdriv audit cache   --url "https://<host>" --paths /<an ungated prerendered path>   # NO cookie: with the gate cookie every request is a BYPASS

# Right after the gate opens: no cookie at all
npx hypdriv audit all --url "https://<host>"
```

Behind a closed gate `audit cache` cannot pass: an anonymous request is answered by the middleware (`307`, `MISS`, never stored) and a request with the cookie is a `BYPASS`. The report grades the security headers (A+ is the goal), validates the CSP coverage, checks the cache behaviour like a browser and HTTPS. Every `fail` is a launch blocker; every `warn` gets a written decision.

---

## 12. Launch checklist and Definition of Done

Work top to bottom. Each line has an evidence column: paste the output (secrets excluded) into the deploy record.

| # | Gate | Evidence |
| --- | --- | --- |
| **Before the build** | | |
| 1 | Bundle checksums verified; Hypdriv installed from `vendor/hypdriv/` (16 tarballs) and committed | `cd <bundle>/tarballs && shasum -a 256 -c ../SHA256SUMS` (26 × `OK`); `git ls-files vendor/hypdriv \| wc -l` = 16 |
| 2 | Patch applied (fleet) or `hypdriv init --no-proxy` run (single app); diff reviewed | `git diff --stat` |
| 3 | Policy reviewed (§9.3): gate cookies, machine routes, embeds, rate limits, CSP allow-list, HSTS decision | the reviewed `hypdriv.config.ts` |
| 4 | Rate Limiting namespace ids unique across the account | `grep -rh namespace_id infra/` and the other repositories' wrangler files |
| 5 | Resources exist: R2 bucket (`enam`), KV namespace; Analytics Engine enabled | the provisioning script's output / `wrangler r2 bucket list` |
| 6 | Secrets present: `HYPDRIV_SESSION_SECRET`, `HYPDRIV_INTERNAL_SECRET`, `CACHE_PURGE_*` | the deploy script's plan view: every secret present for every area |
| **Build** | | |
| 7 | **Every area builds** with the new setup, on the machine that will deploy, and the doctor passes (`0 failed`) | the build script's log: one `built` line per area |
| 8 | `hypdriv analyze` budgets read, any breach has a decision | per area |
| 9 | The deploy script's check mode (`wrangler deploy --dry-run` per config) passes for every config | dry-run output |
| **Staging** | | |
| 10 | Probes 1, 2, 4–9, 11, 13, 14 pass on staging | outputs |
| **Cutover** | | |
| 11 | Zone prepared: HTTPS redirect for the platform's hosts (host-scoped on a shared zone), Early Hints on, no Cache Rule that caches HTML | probe 10 |
| 12 | Hosts attached by the deploy script's cutover mode; probes 1–5, 10 pass on the zone | outputs |
| 13 | Probes 6 and 12 pass on the zone (client IP, purge); probe 3 too if an ungated prerendered route exists, otherwise it moves to row 17 | outputs |
| 14 | Probe 9: zero CSP violations on every route type as an unlocked tester | the empty violation list |
| 15 | Probe 15, closed-gate part: `audit headers`, `csp` and `https` with the gate cookie, `audit cache` on an ungated path without it: no `fail` | report |
| **Open the gate** | | |
| 16 | The gate opened by its normal switch; an anonymous request to a gated-turned-public page is `200`, not a redirect | `curl -sI` output |
| 17 | `warm` run for the static routes **after** the gate opened: cache column `MISS` on the first run, `HIT` on the second (probe 3). While the gate is closed `warm` caches nothing | `npx hypdriv warm --url "$BASE"` twice |
| 18 | Probe 15, open-gate part: `audit all` with no cookie: no `fail` | report |
| **First 24 hours** | | |
| 19 | `wrangler tail` on each area for 10 minutes each: no `error`, no unexpected `403`/`429` | tail excerpts |
| 20 | The first CSP reports from real visitors read and handled: the `csp violation` lines converted to `csp-reports.ndjson` (§6.5) and run through `csp suggest`; "from 0 report(s)" is not evidence | `csp suggest` output with a non-zero report count |
| 21 | Rate-limit and bot-shield decisions revisited from real 429/403 counts | Analytics Engine query |
| 22 | Daily dependency check on (the Hypdriv repository workflow, or `npx hypdriv deps` in the app) | schedule |

**Definition of done** = every row above has evidence, `x-hypdriv-build` is present on the HTML responses of every area and matches the deploy record (the `build` field of the area's health endpoint, or an HTML page of the area), the rollback was drilled once, and the open items in §14 that say **first deploy** each have a recorded outcome (pass, or a ticket with the mitigation active).

---

## 13. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Page renders but never hydrates; console: `Executing inline script violates … script-src` | Rule 1: the R2 cache was empty when the page was first requested, so the page was rendered per request and its hashes do not match | Run `populateCache remote` for that build, then `hypdriv purge --url <base> --all` (a raw Cloudflare tag purge leaves the KV copy); or rebuild and redeploy. `doctor` fails `opennext.cache` only when `open-next.config.ts` has no incremental cache; it cannot see a skipped populate. |
| `UnhandledSchemeError: Reading from "node:fs/promises"` in `next build --webpack` | A tarball older than 2026-10-31 | Install the current bundle (rule 6). |
| Build fails: `secret pattern env:NEXT_DEPLOYMENT_ID` in client assets | Same | Same. |
| `hypdriv.config.ts` fails to load: `"./shared" … write './shared.ts'` | Rule 3 | Add the extension; in a fleet keep `allowImportingTsExtensions` in the area tsconfig (the patch sets it). |
| `MODULE_TYPELESS_PACKAGE_JSON` warning when the doctor or build loads the config | The generated area `package.json` has no `"type": "module"` | Benign (Node re-parses as ESM). Do not add `type: module` to a generated area without a full rebuild test. |
| `Unexpected fields found in top-level field: "tags"` from wrangler | The fleet generator writes `tags` for the day wrangler reads them; the deploy script tags through the API | Benign, present before Hypdriv. |
| `npm install` says "up to date" after replacing tarballs of the same version | npm trusts the lock entry | Use `<bundle>/install.sh` (it clears the Hypdriv entries from `node_modules` and the lock file first) or §4's manual procedure. |
| `npm install` fails with a `vinext` or `waku` peer conflict | All 26 tarballs installed | Install the 16 of §4 only. |
| `wrangler deploy`: Analytics Engine not enabled | Product off for the account | Enable it once in the dashboard (Workers → Analytics Engine). |
| `wrangler deploy`: Durable Object migration error | A migration tag was reused or edited, or a class is exported under another name | Tags are append-only; add a new tag with the change; classes keep the names `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge`, `HypDrivChannel`, `HypDrivLimiter`, `HypDrivIndex`. |
| Deploy: bucket or KV namespace not found | The provisioning script was not run for real, or its ids file is stale | Run it, then regenerate the Wrangler configs; the ids are written into them. |
| Two Workers throttle each other | Shared `ratelimits[].namespace_id` (rule 15) | Allocate per Worker (§7.2) and redeploy both. |
| `403` for a script, monitor or partner | Bot shield, rule 11 | Exempt the route (`security.bots.exempt`); do not loosen `definitelyAutomated` globally. |
| Anonymous visitors see gated pages | Rule 7 | `cache.edge.bypass`; then `hypdriv purge --url <base> --all` (or a fresh deploy) so the pages cached for unlocked visitors leave every tier. |
| Embedded page does not render in a partner's iframe | `X-Frame-Options: DENY` default | Route exception with `frameOptions: false` (§6.3). |
| Cross-origin SDK / `.well-known` fetch fails | CORP `same-site` default | `corp: 'cross-origin'` on those routes (§6.3). |
| `x-hypdriv-cache` is never `HIT` on the zone | Route not cacheable, or on `workers.dev` | Probe 3. |
| Mixed-content or CSP violations only after the gate opens | Third parties not exercised behind the gate | Probe 9 again, as an anonymous visitor in a clean browser profile. |
| Webpack build killed (`Killed`, exit 137) or `JavaScript heap out of memory` | Not enough memory for the area build | Build areas one at a time (the build script's single-area option), close other work, and set `NODE_OPTIONS=--max-old-space-size=8192`. |
| `doctor` fails `security.dev-vars-ignored` | A `.dev.vars` exists in the build directory without a `.gitignore` entry | Remove the file from the generated area directory or add the ignore rule. |
| After `wrangler secret put`, behaviour changes without a deploy | Setting a secret creates and activates a new version | Expected. Roll back with `wrangler rollback` if needed. |
| Every request, `/_hypdriv/health` included, answers `308` in a loop under `wrangler dev` | `redirects.forceHttps` is `auto` (on when `site.origin` is `https`) and the dev server sees `http://` for a Worker with `custom_domain` routes | For the local rehearsal set `redirects.forceHttps: false` (the option takes booleans only). Removing `site.origin` does not stop the loop on Cloudflare, where `auto` is on for every deployment (§6.2). Production sees `https://`. |
| `wrangler dev` does not start after an edit of `hypdriv.config.ts` | An invalid config is loaded at startup and workerd does not report why | Run `npx hypdriv doctor` (`hypdriv.config-valid` prints the validation error). |
| `eslint .` runs out of memory after the build | `.hypdriv/worker-build` holds about 20 MB of bundled output | Add `.hypdriv/**` to ESLint's ignores (`.gitignore` already has it after `hypdriv init`). |
| `/page` and `/page/` both answer with a redirect, or the wrong one, from the edge cache | A bundle older than 2026-10-31 shared one cache key for both forms (rule 6) | Install the current bundle and deploy a fresh build (a new build starts with an empty edge cache); `hypdriv purge --all` does the same without a build. |
| `hypdriv audit` reports `Cache-Control is missing` and MISS/MISS on a `trailingSlash: true` site | An old CLI audited the slashless redirects | Install the current bundle, or pass `--paths` with trailing slashes. |
| An environment (`--env app`) deploys, then answers without the cache / limiter / self reference; `/_hypdriv/health` lists fewer `capabilities` | Wrangler does not inherit bindings into `env.*` (§5.6) | Repeat the full binding set in the environment; `hypdriv doctor --env <name>` and the `wrangler.env-bindings` warning find it. |
| Every route that loads a module by `@/` alias in a template literal returns 500 after the Next 16 upgrade | Turbopack + OpenNext (§5.9 item 4) | Relative path in the `import()`, or `next build --webpack`. |
| `npm install` of wrangler 4.14x+ fails with `ERESOLVE` on `@cloudflare/workers-types` | wrangler peers on workers-types 5.x | Bump `@cloudflare/workers-types` to 5.x in the same install. |
| `security.csp.reportOnly: true` emits no `Content-Security-Policy-Report-Only` | The app sets its own CSP (`x-hypdriv-csp: app`) | §6.5: Hypdriv defers; there is nothing to report. |
| `doctor` flags `security.secret-strength` right after copying `.dev.vars.example` | An older template with placeholders under 32 characters | Replace both values with `openssl rand -base64 32`; the current template's placeholders pass. |
| `wrangler deploy` bundles locally, then the deploy job fails to resolve `./.hypdriv/manifest.js` | `hypdriv.worker.ts` is bundled at deploy time and the job restored only `.open-next/` | Restore `.hypdriv/`, `hypdriv.config.ts` and `node_modules` too (§5.8). |
| `wrangler tail` shows nothing | Wrong Worker name or no traffic reached that area | Probe 5 names the area per path. |

---

## 14. What was verified and what only the first deploy can show

| Capability | Status | Where |
| --- | --- | --- |
| `next build --webpack` with `withHypDriv`, area generator, middleware, 17 routes | **verified** (simulation of a production eight-area platform) | §5, §9 |
| Config loading with explicit `.ts` imports; error text for extensionless imports | **verified** | rule 3 |
| Production OpenNext cache (R2 + regional, DO queue, sharded tag cache, DO purge) with a shared bucket and per-area prefix | **verified** locally in workerd (`populateCache local`: entries written under `site/<deploymentId>/`) | §5.4, §7.1 |
| `populateCache remote` against a real bucket | **first deploy** | probe 2 |
| Hash CSP on prerendered pages, nonce on dynamic, app-set CSP preserved | **verified** | §6 |
| Route header exceptions (embed, machine routes) | **verified** | §6.3 |
| Bot shield: document vs API requests, exempt routes, verified crawlers | **verified** | §6.3, probe 8 |
| Edge cache `bypass` for middleware gates; tiered cache MISS → HIT | **verified** locally (Cache API works in workerd) | §6.4, probe 4 |
| Cache API on the real zone, Early Hints, the zone copies of a purge | **first deploy** (zone only) | probes 3, 12 |
| `hypdriv purge` / `POST /_hypdriv/purge`: host-bound token, validation, removal from the edge cache by tag and path | **verified** in the Hypdriv test suite (host handler and CLI against a fake endpoint); on a real Worker and zone it is a **first deploy** item | probe 12 |
| Exact rate limiter (Durable Object): 120 allowed, then 429 with `Retry-After` | **verified** locally | probe 7 |
| `request.cf` / client IP through router → area service binding | **first deploy** | probe 6 |
| One KV namespace shared by the area Workers of a platform | **first deploy** (isolation by cache key and prefix is by design; the maintenance, redirect and flag switches are shared on purpose) | §7.1 |
| `ratelimits` namespaces unique and independent per Worker | **first deploy** | probe 7 |
| Fleet patch: generated configs, `wrangler deploy --dry-run`, doctor `--wrangler` | **verified** on a copy of a production generator | §9.2 |
| Fleet patch over the **real application source**, all eight areas | **first run on the deploying machine** (gate 7) | §12 |
| Wrangler environments: full binding set per `env.<name>`, `wrangler deploy --dry-run --env`, `doctor --env`, `analyze --env`; four environments bundling to one identical Worker | **verified** (simulation of a four-Worker, one-config app) | §5.6 |
| Next 15 → 16 upgrade of a 226-page app, then Hypdriv: build, doctor, `wrangler dev`, `audit all`; the app's gate, redirects, locale, nonce CSP, embed framing and rate limits unchanged with Hypdriv in front | **verified** (simulation; signed-in surface **not exercised**) | §5.9 |
| Site gate in front of Hypdriv: a cached page is never served around the gate; `www`/http redirect before any Hypdriv stage | **verified** locally | §6.4 |
| Nonce CSP and hash CSP in a real browser on five route types (home, locale page, article, 404, deep 404): 0 violations, hydration fine; hash mode without a populated cache blocks 5 to 7 inline scripts per page | **verified** locally | §6.5 |
| `trailingSlash: true` site: `/x` and `/x/` in either order, no redirect loop, HIT on repeat | **verified** locally | rule 6 |
| DO migrations `opennext-v1` / `hypdriv-v1` on first `wrangler deploy` | **first deploy** | probe 1 |
| Self service binding `WORKER_SELF_REFERENCE` on a Worker's first deploy | **first deploy** (OpenNext's documented pattern; accepted by dry-run) | probe 1 |
| Maintenance switch via secret; via KV | secret: **first deploy**; KV needs config beforehand | probe 13 |
| Chaining an existing `scheduled` handler | **verified** locally on a single-app platform (`wrangler dev --test-scheduled`: a cron Hypdriv owns goes to Hypdriv, every other cron to the app's handler); the real cron schedule is **first deploy** | §8.7 |
| Analytics Engine rows for traces, vitals, CSP reports | **first deploy** | probe 11 |
| `pnpm` with `file:` tarballs | **not exercised**: stay on npm | rule 17 |
| Plain Worker fleets (API gateway, queue consumers, Prisma back-ends) | **out of scope**: Hypdriv has no integration | §1 |


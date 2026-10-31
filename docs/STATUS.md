# HypDriv — build status and handoff

_Updated 2026-10-31 (live Vercel run on the Hobby plan; Cloudflare re-verified). Read this first when resuming._

## State

Every package, both platforms and the scaffolder are implemented and verified on real accounts: Cloudflare (2026-10-30, re-run 2026-10-31) and Vercel Hobby (2026-10-31). Gate on the last commit: `pnpm lint` ✓ · `pnpm typecheck` ✓ · `pnpm build` ✓ (no warnings; `'use client'` boundaries enforced) · `pnpm test` ✓ **1060 tests in 105 files** (Node + workerd) · `tsc` for both e2e apps ✓.

| Package | Highlights |
| --- | --- |
| `@hypdriv/core` | config (`platform`, `vercel`, `jobs.queues[].queues`, `cache.edge.memoryTtl`, `turnstile.siteKeyEnv`), pipeline, manifest (+ `fingerprint`, `revalidation.tokenHash`, `cacheVersion()`), `queueConsumerFor`, `detectDeployTarget`, runtime registry |
| `@hypdriv/cache` | edge cache engine; fingerprint-scoped keys; `path:` tags; short-lived memory tier; `Cache-Tag` on Cache API copies; purge tombstones (`markPurged`, `fetchedAt`) — ADR 0017 |
| `@hypdriv/security` | CSP, headers, rate limits, bots (Turnstile `siteKeyEnv`), shield, actions, sessions, crypto, owner audit tokens (ADR 0015) |
| `@hypdriv/next` | `withHypDriv` (deployment ids per build — ADR 0016), adapter (preview-mode id hash, matcher redaction, tag-revalidated prerenders are `isr` — ADR 0018), `createProxy`, `createInstrumentation` (Vercel CDN purger in functions), `jobHandler` (config secret envs, cron schedule by path), `hypdriv/cache` with repeat purge under `waitUntil` |
| `@hypdriv/cloudflare` | Worker shell with ISR pass-through for OpenNext's queue, DOs (index tombstones), handlers (queue name mapping, tail outcomes), `enqueue()` |
| `@hypdriv/vercel` | Vercel CDN stage (route-header limits reported with `x-hypdriv-cache-reason`), purge (CDN `hyp:path:` tags from `path:` tags), Upstash/Global Config, WAF, BotID, Queues |
| `@hypdriv/flags` | KV provider returns to config definitions when the KV key is deleted |
| `@hypdriv/cli` | 15 commands, 92 doctor checks (new `opennext.cache`, richer `wrangler.queues`, per-build deployment ids), `vitals` ignores span rows |
| `create-hypdriv` | templates ship OpenNext's full cache setup; never copy `wrangler.*.local.jsonc` or local env files |
| `e2e/cloudflare` | live suite: app + runner (43 checks) + `provision` script for any account |
| `e2e/vercel` | live suite: app + runner (41 checks, runtime-logs stream) + `provision` script for any Vercel team |

## Verified end to end

- **Vercel, live (2026-10-31, Hobby)** — projects `avonao-hypdriv-dev-vercel`, `…-vercel-purser`, `…-vercel-e2e` (`iad1`, monorepo root directories, prebuilt deploys, deployment meta `tag=hypdriv-dev`), **private**: Vercel Authentication on all deployments, tooling through the automation bypass, no custom domains. Live suite 39 pass / 0 fail / 2 skipped (no 103 on Vercel; Turnstile pass flow run separately with test keys: pass); `hypdriv audit all` passes on both examples and the e2e app; doctor 59/0/0. Report: [`docs/testing/vercel-live-2026-10-31.md`](testing/vercel-live-2026-10-31.md).

- **Cloudflare, live (2026-10-30, re-run 2026-10-31 behind a gate)** — account "avonao", all resources named `avonao-hypdriv-dev*`, Workers tagged `hypdriv-dev`; private since 2026-10-31 (zone WAF gate, `workers.dev` off). `examples/basic`, `examples/with-purser` and `e2e/cloudflare` on custom domains under `avonao.dev`. `hypdriv audit all` passes on both examples (A+, CSP ok, edge HIT, Purser 81 checks / 0 overrides); live suite 41 pass / 0 fail / 2 skipped (email; Turnstile pass flow run separately with test keys: pass); HTTP/2 103 Early Hints observed. Report: [`docs/testing/cloudflare-live-2026-10-30.md`](testing/cloudflare-live-2026-10-30.md).
- **Cloudflare / workerd (local)** — `opennextjs-cloudflare build` → `wrangler dev` → `hypdriv audit all` on both Cloudflare examples.
- **Vercel (local)** — `next build` with `VERCEL=1`, `vercel build` (Build Output API), `next start` + `hypdriv audit all`, Vercel Cron with `CRON_SECRET`.
- **Release check** — packed tarballs, apps scaffolded by the packed `create-hypdriv` build on both platforms.

## Bugs found by the live Vercel run (all fixed, with tests)

Tag-revalidated prerenders kept build-time CSP hashes and broke after `revalidateTag()` (both platforms; ADR 0018) · `revalidatePath()`/`revalidateTag()` from Vercel Functions did not purge HypDriv's CDN tags · awaited body cancels and signal-dependent timeouts could hang functions under Next's teed `fetch` · `vary` pages reported as CDN-cached on Vercel · `jobHandler` ignored configured secret env names and the cron schedule · health `deployment: null` and no config-store line on Vercel · vitals without country on Vercel · monorepo Vercel links invisible to doctor/analyze/audit · misleading `vercel.botId` docs · unenforced `'use client'` boundaries in the package build · internal routes and static assets served over plain HTTP on Workers despite `forceHttps` · CLI tooling unable to pass gateways other than Vercel's (and `jobs run` not even that).

## Bugs found by the live Cloudflare run (all fixed, with tests)

Cross-app cache contamination from commit-only deployment ids (ADR 0016) · stale pages after `revalidateTag()` across isolates, colos and in-flight requests (ADR 0017) · ISR never regenerating (OpenNext no-op defaults; revalidation requests would have hit the edge cache and bot shield) · KV flags stuck after key deletion · span rows in `hypdriv vitals` · queue names fixed to the config key · tail ignoring limit/cancel outcomes · Turnstile site key only as a literal.

## Live infrastructure

**Cloudflare (avonao account):**

Workers `avonao-hypdriv-dev-{basic,purser,e2e}` (+ custom domains `…avonao.dev`); KV `avonao-hypdriv-dev-{basic,purser,e2e}-kv`; R2 `avonao-hypdriv-dev-{basic,purser,e2e}-cache` (enam); queues `avonao-hypdriv-dev-e2e-jobs(-dlq)`; Turnstile widget `avonao-hypdriv-dev`; AE datasets `avonao_hypdriv_dev_*`; a scoped Cache Purge token; zone `avonao.dev` Early Hints and Image Resizing turned on (were off). The e2e Worker runs a cron every minute. Account-specific wrangler configs are git-ignored (`wrangler.avonao-hypdriv-dev.local.jsonc`); secrets live only in the operator's environment and the Workers.

**Vercel (team on Hobby):** projects `avonao-hypdriv-dev-vercel`, `avonao-hypdriv-dev-vercel-purser`, `avonao-hypdriv-dev-vercel-e2e` on their `.vercel.app` URLs, private (Vercel Authentication on all deployments, one automation bypass per project, kept in the operator's secrets files); Global Config store `avonao-hypdriv-dev-vercel-e2e` (+ read token); WAF rule `avonao-hypdriv-dev-vercel-e2e-waf`; Vercel Queues topics `hypdriv-e2e-jobs(-once)`; cron `/api/jobs/tick` daily; Turnstile reuses the `avonao-hypdriv-dev` widget. Project secrets are sensitive env vars; the team token is never in a deployment.

**Nothing is public.** Cloudflare: `workers.dev` off for the three Workers; zone WAF rule `hypdriv-dev: private HypDriv test Workers (gate header or cookie)` on `avonao.dev` blocks HTTPS requests to `avonao-hypdriv-dev-{basic,purser,e2e}.avonao.dev` without the gate (secret in the operator's `gate.json`; tooling sends it via `HYPDRIV_ACCESS_HEADERS`). The planned `avonao.dev` → `dev.avonao.com` forward must leave these three hostnames out (an apex/`www` rule), or the Workers move to another zone.

## Open items (need credentials or a decision, not code)

1. Publishing: npm org `@hypdriv` + `hypdriv`/`create-hypdriv` names, `NPM_TOKEN` for `changeset publish`; GitHub repo `avonao/hypdriv` for CI.
2. Upstash Redis on Vercel: installing it from the Marketplace needs the account owner to accept Upstash's terms (`vercel integration add upstash/upstash-kv`); then connect it to `avonao-hypdriv-dev-vercel-e2e` and re-run `rate-limit` for exact global counters.
3. Inbound email test: an Email Routing rule to `avonao-hypdriv-dev-e2e` and an external sender.
4. `@avonao/purser` is unpublished; examples use a local copy (`node_modules/@avonao/purser`, copied from `/Users/apple.m5.pro/Workspace/purser`: `package.json src types bin scripts`).

## Where things live

- Cloud working copy: `/home/claude/hypdriv` (ephemeral). Durable copy: `/Users/apple.m5.pro/Workspace/HypDriv/repo` (synced by tarball; avoid git writes on the Mac copy — deletion-protected folders leave git lock files).
- Purser (read-only, never edited): `/Users/apple.m5.pro/Workspace/purser`.

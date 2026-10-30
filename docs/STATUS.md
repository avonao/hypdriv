# HypDriv — build status and handoff

_Updated 2026-10-30 (end of day 2, live Cloudflare run). Read this first when resuming._

## State

Every package, both platforms and the scaffolder are implemented and verified, now also on a real Cloudflare account. Gate on the last commit: `pnpm lint` ✓ · `pnpm typecheck` ✓ · `pnpm build` ✓ (no warnings) · `pnpm test` ✓ **1043 tests in 105 files** (Node + workerd).

| Package | Highlights |
| --- | --- |
| `@hypdriv/core` | config (`platform`, `vercel`, `jobs.queues[].queues`, `cache.edge.memoryTtl`, `turnstile.siteKeyEnv`), pipeline, manifest (+ `fingerprint`, `revalidation.tokenHash`, `cacheVersion()`), `queueConsumerFor`, `detectDeployTarget`, runtime registry |
| `@hypdriv/cache` | edge cache engine; fingerprint-scoped keys; `path:` tags; short-lived memory tier; `Cache-Tag` on Cache API copies; purge tombstones (`markPurged`, `fetchedAt`) — ADR 0017 |
| `@hypdriv/security` | CSP, headers, rate limits, bots (Turnstile `siteKeyEnv`), shield, actions, sessions, crypto, owner audit tokens (ADR 0015) |
| `@hypdriv/next` | `withHypDriv` (deployment ids per build — ADR 0016), adapter (preview-mode id hash, matcher redaction), `createProxy`, `hypdriv/cache` with repeat purge |
| `@hypdriv/cloudflare` | Worker shell with ISR pass-through for OpenNext's queue, DOs (index tombstones), handlers (queue name mapping, tail outcomes), `enqueue()` |
| `@hypdriv/vercel` | Vercel CDN stage, purge, Upstash/Global Config, WAF, BotID, Queues |
| `@hypdriv/flags` | KV provider returns to config definitions when the KV key is deleted |
| `@hypdriv/cli` | 15 commands, 92 doctor checks (new `opennext.cache`, richer `wrangler.queues`, per-build deployment ids), `vitals` ignores span rows |
| `create-hypdriv` | templates ship OpenNext's full cache setup; never copy `wrangler.*.local.jsonc` or local env files |
| `e2e/cloudflare` | live suite: app + runner (43 checks) + `provision` script for any account |

## Verified end to end

- **Cloudflare, live (2026-10-30)** — account "avonao", all resources named `avonao-hypdriv-dev*`, Workers tagged `hypdriv-dev`. `examples/basic`, `examples/with-purser` and `e2e/cloudflare` on custom domains under `avonao.dev`. `hypdriv audit all` passes on both examples (A+, CSP ok, edge HIT, Purser 81 checks / 0 overrides); live suite 41 pass / 0 fail / 2 skipped (email; Turnstile pass flow run separately with test keys: pass); HTTP/2 103 Early Hints observed. Report: [`docs/testing/cloudflare-live-2026-10-30.md`](testing/cloudflare-live-2026-10-30.md).
- **Cloudflare / workerd (local)** — `opennextjs-cloudflare build` → `wrangler dev` → `hypdriv audit all` on both Cloudflare examples.
- **Vercel (local)** — `next build` with `VERCEL=1`, `vercel build` (Build Output API), `next start` + `hypdriv audit all`, Vercel Cron with `CRON_SECRET`.
- **Release check** — packed tarballs, apps scaffolded by the packed `create-hypdriv` build on both platforms.

## Bugs found by the live run (all fixed, with tests)

Cross-app cache contamination from commit-only deployment ids (ADR 0016) · stale pages after `revalidateTag()` across isolates, colos and in-flight requests (ADR 0017) · ISR never regenerating (OpenNext no-op defaults; revalidation requests would have hit the edge cache and bot shield) · KV flags stuck after key deletion · span rows in `hypdriv vitals` · queue names fixed to the config key · tail ignoring limit/cancel outcomes · Turnstile site key only as a literal.

## Live infrastructure (avonao account)

Workers `avonao-hypdriv-dev-{basic,purser,e2e}` (+ custom domains `…avonao.dev`); KV `avonao-hypdriv-dev-{basic,purser,e2e}-kv`; R2 `avonao-hypdriv-dev-{basic,purser,e2e}-cache` (enam); queues `avonao-hypdriv-dev-e2e-jobs(-dlq)`; Turnstile widget `avonao-hypdriv-dev`; AE datasets `avonao_hypdriv_dev_*`; a scoped Cache Purge token; zone `avonao.dev` Early Hints and Image Resizing turned on (were off). The e2e Worker runs a cron every minute. Account-specific wrangler configs are git-ignored (`wrangler.avonao-hypdriv-dev.local.jsonc`); secrets live only in the operator's environment and the Workers.

## Open items (need credentials or a decision, not code)

1. Publishing: npm org `@hypdriv` + `hypdriv`/`create-hypdriv` names, `NPM_TOKEN` for `changeset publish`; GitHub repo `avonao/hypdriv` for CI.
2. Vercel live run: a Vercel team (US, `iad1`) to deploy `examples/vercel*` and run the audits, Vercel Queues (beta) and WAF rules live.
3. Inbound email test: an Email Routing rule to `avonao-hypdriv-dev-e2e` and an external sender.
4. `@avonao/purser` is unpublished; examples use a local copy (`node_modules/@avonao/purser`, copied from `/Users/apple.m5.pro/Workspace/purser`: `package.json src types bin scripts`).

## Where things live

- Cloud working copy: `/home/claude/hypdriv` (ephemeral). Durable copy: `/Users/apple.m5.pro/Workspace/HypDriv/repo` (synced by tarball; avoid git writes on the Mac copy — deletion-protected folders leave git lock files).
- Purser (read-only, never edited): `/Users/apple.m5.pro/Workspace/purser`.

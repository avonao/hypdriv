# HypDriv — build status and handoff

_Updated 2026-10-30 (end of day 2). Read this first when resuming._

## State

Every package, both platforms and the scaffolder are implemented and verified. Gate on the last commit: `pnpm lint` ✓ · `pnpm typecheck` ✓ · `pnpm build` ✓ (no warnings) · `pnpm test` ✓ **1015 tests in 103 files** (Node + workerd).

| Package | Highlights |
| --- | --- |
| `@hypdriv/core` | config (`platform`, `vercel`), pipeline, manifest (+ `fingerprint`, `cacheVersion()`), `detectDeployTarget`, runtime registry, `isResolvedConfig` brand, trusted-header sanitiser (`x-hypdriv-audit`) |
| `@hypdriv/cache` | edge cache engine; keys scoped to the build fingerprint (ADR 0007 amendment); `CacheStatus` `CDN`; edge purger registry |
| `@hypdriv/security` | CSP (response policy on proxy pass-through too), headers, rate limits, bots, shield, actions, sessions, crypto, **owner audit tokens** (ADR 0015) |
| `@hypdriv/next` | `withHypDriv` (target-aware, Vercel CDN route headers), adapter chain (scoped-artifact mirroring, manifest traced into functions — ADR 0014), `createProxy` (auto-wires Vercel, registers the runtime), server/client helpers, instrumentation |
| `@hypdriv/cloudflare` | Worker shell, DOs, handlers, `enqueue()` (Queues → platform producer → signed consumer route, works outside a request context) |
| `@hypdriv/vercel` | Vercel CDN stage + `withVercelCdn` + `vercelCdnRouteHeaders`, purge, Upstash KV/counters, Global Config, WAF, BotID, Queues, `vercelEnv`/`vercelPlatformOverrides`/`vercelStages` |
| `@hypdriv/purser` | bridge, guard, themes (proxy negotiation headers), zero-override audit (scoped headers via DevTools Fetch, fails HTTP errors and pages without evaluable CSS) |
| `@hypdriv/cli` | 15 commands, 91 platform-aware doctor checks, audit tokens + Vercel bypass, browser-like cache audit, declared CSP fallback as warning |
| `create-hypdriv` | `--platform cloudflare|vercel`, `--purser`, `--pm`, prompts, generated secrets, Workers-safe names; templates = the four example apps, synced at build |
| `hypdriv` | umbrella incl. `hypdriv/vercel` |
| `@hypdriv/observe` / `flags` / `live` / `image` / `devtools` / `testing` | unchanged APIs; `web-vitals` is now a real dependency of observe |

## Verified end to end (2026-10-30)

- **Cloudflare / workerd** — `examples/basic`: `opennextjs-cloudflare build` → `populateCache local` → `wrangler dev` → `hypdriv audit all`: headers A+ on all routes, CSP hash/nonce all ok, edge cache HIT on policy routes; health lists DO/KV/AE/Images capabilities. `examples/with-purser`: same plus the Purser zero-override audit (81 checks, 94 author rules evaluated, 0 overrides).
- **Vercel** — `examples/vercel` and `examples/vercel-purser`: `next build` with `VERCEL=1` (no warnings), `vercel build` (Build Output API: CDN header route in `config.json`, prerenders present, manifest in every function's `filePathMap`), `next start` + `hypdriv audit all` (A+ static, declared `'unsafe-inline'` fallback warnings for ISR/PPR, Vercel CDN headers planned, Purser audit 0 overrides), Vercel Cron `GET` with `CRON_SECRET` (200; 401 without), `hypdriv jobs run`.
- **Release check** — every package packed with `pnpm pack`; apps scaffolded by the packed `create-hypdriv` installed from the tarballs with npm: Vercel app `next build` ✓, Cloudflare app `opennextjs-cloudflare build` ✓ and `wrangler deploy --dry-run` ✓ (1.8 MB gzip), packed CLI `doctor` 52 pass / 0 fail.

## Bugs found and fixed by those runs

Purser audit passed vacuously on a bot-shield 403 · CSP header missing on all proxy-runner pages (Node/Vercel) · audit tokens rejected when `next start` rewrites the URL host · `web-vitals` optional peer broke fresh-install builds · literal `node:crypto` import warned in Edge builds · bare chunk import warned in wrangler · KV edge cache served another build's HTML after a same-commit rebuild (deterministic BUILD_ID) · doctor warned about deployment ids on Vercel.

## Decisions recorded this session

ADR 0013 (deploy targets), 0014 (scoped build artifacts), 0015 (owner audit tokens), 0007 amendment (fingerprint keys). Guides: `docs/guides/vercel.md` (new), getting started, Cloudflare, CLI, observability; feature catalog section 5 (Vercel); README, AGENTS.md, skill updated. Changesets cover every changed package.

## Open items (need credentials or a decision, not code)

1. Publishing: npm org `@hypdriv` + `hypdriv`/`create-hypdriv` names, `NPM_TOKEN` for `changeset publish`; GitHub repo `avonao/hypdriv` for CI.
2. Real deployments: a Cloudflare account (wrangler login) and a Vercel team (US, `iad1`) to run the audits against production URLs, Vercel Queues (beta) and WAF rules live.
3. `@avonao/purser` is unpublished; examples use a local copy (`node_modules/@avonao/purser`, copied from `/Users/apple.m5.pro/Workspace/purser`: `package.json src types bin scripts`).

## Where things live

- Cloud working copy: `/home/claude/hypdriv` (ephemeral). Durable copy: `/Users/apple.m5.pro/Workspace/HypDriv/repo` (synced by tarball; avoid git writes on the Mac copy — deletion-protected folders leave git lock files).
- Purser (read-only, never edited): `/Users/apple.m5.pro/Workspace/purser`.

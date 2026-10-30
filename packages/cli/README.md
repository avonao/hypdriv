# @hypdriv/cli

The `hypdriv` command for [HypDriv](https://github.com/avonao/hypdriv) — set up, diagnose, measure and audit a Next.js 16+ application on **Cloudflare Workers** (OpenNext) or **Vercel**.

```sh
pnpm add hypdriv          # the umbrella package ships the `hypdriv` binary
npx hypdriv init          # wire the project (idempotent, backs up edited files)
npx hypdriv doctor        # 90+ checks with fixes
```

Zero runtime dependencies beyond the `@hypdriv/*` packages; Node.js 20.9+ (22+ recommended: native TypeScript config loading and `WebSocket` for the CSS audit).

## Conventions

- Every command accepts `--json` (exactly one JSON document on stdout, nothing else — `css watch --json` streams one JSON line per rebuild), `--root <dir>` (default: nearest `package.json`), `--platform cloudflare|vercel|node` (default: detected), `--no-color` and `--help`. `NO_COLOR` and non-TTY output disable colours.
- Exit codes: `0` ok · `1` findings or failures · `2` usage error. With `--json`, errors are printed as `{ "ok": false, "error": { "type", "message" } }`.
- Platform detection: a Vercel build environment (`VERCEL`) wins; otherwise wrangler config, `@opennextjs/cloudflare`, `cloudflare.config.ts` and `hypdriv.worker.ts` point to Cloudflare, `vercel.json`/`vercel.ts`, `@hypdriv/vercel` and `.vercel/` to Vercel. A project with neither is `node` (`next start`).

## Commands

| Command | What it does |
| --- | --- |
| `hypdriv init [--purser] [--no-proxy] [--yes] [--dry-run] [--platform …]` | Detects the project, prints a plan (create / modify / skip / manual with reasons) and applies it. Cloudflare: `hypdriv.config.ts`, `next.config.*` wrapped in `withHypDriv()` (identifier, object literal, function and `module.exports` shapes), `hypdriv.worker.ts`, `wrangler.jsonc#main` + `observability` + cron triggers (targeted edits keep comments; `wrangler.toml` gets printed instructions), `tsconfig.json#exclude` for the worker entry, `proxy.ts` (or composition instructions when one exists), `public/_headers`, `.dev.vars.example`, `instrumentation.ts`, scripts and the `hypdriv` dependency. Vercel: no Worker files; `jobs.cron` → `vercel.json#crons`, `.env.example`. Edited files are backed up as `<name>.hypdriv.bak`; a second run changes nothing. Ends with the doctor and next steps. |
| `hypdriv doctor [--fix] [--ci] [--only <ids>] [--category <name>] [--list-checks]` | 90+ checks in eleven categories (environment, nextjs, opennext, wrangler, vercel, workers-compat, hypdriv, size, security, purser, deps). Platform-specific checks report `skip` elsewhere. `--fix` applies safe fixes (cron sync for wrangler and `vercel.json`, observability, `_headers`, scripts, `tsconfig` exclude, env examples) and re-runs them. `--ci` prints only findings and exits 1 on any failure. |
| `hypdriv analyze [--worker] [--routes] [--no-build] [--top <n>]` | Cloudflare: reuses `.hypdriv/worker-build` when it is newer than `.open-next/worker.js`, otherwise runs `wrangler deploy --dry-run --outdir .hypdriv/worker-build`; raw and gzip size vs the 64 MiB limit, source-map attribution (base64 VLQ) to modules and packages, duplicate installations, top-level `await`s, OpenNext's esbuild metafile. Vercel: every function in `.vercel/output` (files plus `filePathMap` traces) vs the 250 MB uncompressed limit, Edge functions by gzip size. Per-route JS/CSS from the manifest, budgets; writes `weights.worker` into the manifest and `.hypdriv/analyze.json`. |
| `hypdriv routes [--css] [--cache] [--csp] [--all]` | The manifest as a table: route, kind, class, revalidate, cache policy, CSP mode (`hash` for static routes with hashes, `nonce` otherwise, `—` for handlers), hints, JS, CSS; Purser atoms with `--css`. |
| `hypdriv audit <headers\|csp\|cache\|css\|all> --url <base> [--paths a,b] [--limit 20]` | Fetches routes from the manifest (static and ISR first, one concrete path per dynamic route, then `/`) with a desktop browser User-Agent, 10 s timeout and no redirect following. `headers`: securityheaders.com-style grade (A+ needs CSP, HSTS, X-Content-Type-Options, X-Frame-Options or `frame-ancestors`, Referrer-Policy, Permissions-Policy and no deductions). `csp`: policy hardening, nonce on every script in nonce mode, inline scripts matching the hashes in hash mode. `cache`: two requests, `x-hypdriv-cache` (or Vercel's `x-vercel-cache`) MISS → HIT/STALE, `Age`, `Vary: rsc`, `Cache-Control`. `css`: Purser's zero-override check in headless Chrome. |
| `hypdriv budget [--ci] [--snapshot] [--diff] [--markdown]` | Budgets from the manifest and `.hypdriv/analyze.json`; snapshots under `.hypdriv/snapshots/<buildId>.json`; diffs against the previous snapshot; Markdown for PR comments. |
| `hypdriv csp hashes [--route <path>]` · `csp suggest --reports <file.ndjson>` · `csp print [--route <path>] [--dev]` | Static route hashes; allow-list proposals from collected violation reports; the effective policy for a route. |
| `hypdriv css build\|check\|watch` | Purser through the bridge with the configured options; diagnostics in `file:line:col` form. |
| `hypdriv warm --url <base> [--concurrency 4] [--paths …]` | Fetches `cache.warm.routes` (or every static/ISR route) and prints status, cache status and time. |
| `hypdriv bench --url <base> [--paths …] [--n 20] [--concurrency 4]` | TTFB p50/p95/max, status and cache-status distribution per path. |
| `hypdriv deps [--update safe\|major] [--only <name>] [--dry-run]` | Dependency freshness across the pnpm workspace (root, `packages/*`, `examples/*`, `catalog:` and named catalogs, `npm:` aliases) from the npm registry (abbreviated documents, concurrency 8). JSON: `{ generatedAt, packages: [{ name, path, outdated: [{ name, current, latest, diff, dev }] }] }`. `--update safe` rewrites patch/minor ranges (and catalog lines in `pnpm-workspace.yaml`) and prints the install command; `--update major` requires `--only`. |
| `hypdriv manifest [--validate] [--summary]` | Prints, summarises or validates `.hypdriv/manifest.json` (unique route ids, regexes, CSP hash format, parseable Early Hints, Purser atoms). |
| `hypdriv jobs list` · `jobs run <name> --url <base> [--payload <json>]` | Sends a request signed with `HYPDRIV_INTERNAL_SECRET` (from the environment, `.dev.vars` or `.env.local`) to the job route; on Vercel cron jobs are called with GET and `Authorization: Bearer $CRON_SECRET`, as Vercel Cron does. |
| `hypdriv vitals [--days 7] [--route <path>] [--dataset <name>] [--sql]` | p75 per route and metric from Workers Analytics Engine's SQL API (`CF_ACCOUNT_ID`, `CF_API_TOKEN`), dataset from the `HYPDRIV_ANALYTICS` binding in the wrangler config. |
| `hypdriv agent` | A Markdown (or `--json`) briefing for coding agents: setup, configuration summary, open issues, commands, docs. |

## CI

```yaml
- run: pnpm build
- run: npx hypdriv doctor --ci
- run: npx hypdriv budget --ci
- run: pnpm preview & npx wait-on http://localhost:8787 && npx hypdriv audit all --url http://localhost:8787
```

## Programmatic use

```ts
import { createMemoryIO, runCommand } from '@hypdriv/cli';

const io = createMemoryIO({ cwd: '/path/to/app', fetch, env: process.env });
const code = await runCommand('doctor', ['--json'], io);
const report = JSON.parse(io.out);
```

`main(argv, io?)` is the binary's entry point (`process.exitCode = await main(process.argv.slice(2))`); it never calls `process.exit`. Every command takes an injectable `IO` (`stdout`, `stderr`, `cwd`, `env`, `fetch`, `exec`, clock), so tests never touch the network or spawn processes. The doctor registry (`allChecks`, `runDoctor`), the audit graders (`gradeHeaders`, `auditCsp`, `auditCache`), the source-map tools (`decodeVlq`, `attributeBytes`) and project detection (`detectProject`, `detectPlatform`) are exported too.

## License

MIT

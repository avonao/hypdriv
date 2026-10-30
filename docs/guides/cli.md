# The `hypdriv` CLI

All commands accept `--root <dir>` (project directory, default: nearest `package.json`) and `--json` (machine-readable output). Exit codes: `0` ok, `1` findings/failures, `2` usage error.

| Command | What it does |
| --- | --- |
| `hypdriv init [--purser] [--no-proxy] [--yes]` | Detects the project and writes/updates `hypdriv.config.ts`, `next.config.ts` (wraps with `withHypDriv`), `hypdriv.worker.ts`, `wrangler.jsonc#main`, `proxy.ts`, `public/_headers`, scripts. Backs up edited files as `*.hypdriv.bak`. |
| `hypdriv doctor [--fix] [--ci]` | 40+ checks: Node/pnpm, Next.js version & config, adapter chain, `proxy.ts` vs deprecated `middleware.ts`, Edge runtime segments, wrangler compatibility date/flags/bindings/triggers, Node APIs unsupported on workerd, Worker size vs limits, startup risks, env leaks, header posture (from the manifest), Purser setup and TS compatibility, dependency freshness. `--fix` applies safe fixes (cron sync, `_headers`, scripts). |
| `hypdriv analyze [--worker] [--routes]` | Worker weight report: runs `wrangler deploy --dry-run --outdir` (or reads an existing bundle), attributes bytes to modules via the source map and the OpenNext esbuild metafile, lists largest modules/packages/duplicates and top-level `await`s; per-route JS/CSS (gzip) from the manifest; budget evaluation. Writes `weights.worker` back into `.hypdriv/manifest.json`. |
| `hypdriv routes [--css] [--cache] [--csp]` | Table of routes with classification, revalidate, cache policy, CSP mode, hints count, JS/CSS weight, Purser atoms. |
| `hypdriv audit <headers|csp|cache|css|all> --url <base>` | Fetches routes from the manifest (or `--paths`) against a running server: grades security headers (A+ model), validates CSP syntax and nonce/hash presence, checks cache statuses and `Age`/`Vary`, and runs Purser's zero-override check in headless Chrome (`css`). |
| `hypdriv budget [--ci] [--snapshot] [--diff]` | Evaluates budgets from the manifest and the worker report, stores snapshots under `.hypdriv/snapshots`, prints Markdown diffs for PR comments. |
| `hypdriv csp hashes [--route <path>]` / `hypdriv csp suggest [--reports <file>]` / `hypdriv csp print` | Shows static route hashes, proposes allow-list additions from collected violation reports, prints the effective policy. |
| `hypdriv css build|check|watch` | Purser through the bridge with the config's options. |
| `hypdriv warm --url <base> [--concurrency 4]` | Fetches the configured warm routes (or all static routes). |
| `hypdriv bench --url <base> [--paths …] [--n 20]` | TTFB p50/p95 and cache status distribution per path. |
| `hypdriv deps [--update safe|major] [--only <name>]` | Dependency freshness across the workspace (npm registry): patch/minor/major classification, optional updates. |
| `hypdriv manifest [--validate]` | Prints or validates `.hypdriv/manifest.json`. |
| `hypdriv jobs run <name> --url <base>` | Sends a signed internal request to a job route. |
| `hypdriv vitals [--days 7]` | p75 per route from Analytics Engine (`CF_ACCOUNT_ID`, `CF_API_TOKEN`). |
| `hypdriv agent` | Prints agent guidance for this project (what is configured, what to run). |

Add to CI:

```yaml
- run: pnpm build
- run: npx hypdriv doctor --ci
- run: npx hypdriv budget --ci
- run: pnpm preview & npx wait-on http://localhost:8787 && npx hypdriv audit all --url http://localhost:8787
```

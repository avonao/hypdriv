# The `hypdriv` CLI

All commands accept `--root <dir>` (project directory, default: nearest `package.json`), `--json` (machine-readable output), `--wrangler <file>` (read this Wrangler config instead of `<root>/wrangler.jsonc`: for a generated or shared config that lives outside the project, e.g. one `infra/<worker>.wrangler.jsonc` per area of a multi-Worker build; relative `main`/`assets` paths resolve against that file as Wrangler does; `HYPDRIV_WRANGLER_CONFIG` does the same), `--env <name>` (check `env.<name>` of that config as Wrangler resolves it: the top level without its non-inherited bindings, overlaid with the environment; `HYPDRIV_WRANGLER_ENV` does the same; `hypdriv analyze` measures the same config and environment) and, where the deploy target matters, `--platform cloudflare|vercel|node` (default: detected from `hypdriv.config.ts#platform`, `wrangler.*` / `@opennextjs/cloudflare`, `vercel.json` / `.vercel`, `VERCEL=1`). Exit codes: `0` ok, `1` findings/failures, `2` usage error.

| Command | What it does |
| --- | --- |
| `hypdriv init [--platform …] [--purser] [--no-proxy] [--yes] [--dry-run]` | Detects the project and writes/updates `hypdriv.config.ts`, `next.config.ts` (wraps with `withHypDriv`), `proxy.ts`, `instrumentation.ts`, scripts and, per platform, `hypdriv.worker.ts` + `wrangler.jsonc#main` + `public/_headers` + `.dev.vars.example` (Cloudflare) or `vercel.json#crons` + `.env.example` (Vercel). For Vite hosts (plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext) it registers the integration in the framework's own config (Vite plugins, Astro integrations, Nuxt modules, the React Router preset, root middleware and server entry, `withHypDriv()` around TanStack Start's options and `src/start.ts`, the SvelteKit adapter wrapper and `handle` hook) and writes the platform files (Worker entry, wrangler `main`, assets routing and HypDriv's Durable Objects on Cloudflare; the Node server and `start` script); edits it cannot place safely are printed as manual steps. Backs up edited files as `*.hypdriv.bak` and adds `.dev.vars` (Cloudflare), `.hypdriv/` and `*.hypdriv.bak` to `.gitignore` (append-only, no backup). |
| `hypdriv doctor [--fix] [--ci]` | 90+ checks for the detected platform: Node/pnpm, Next.js version & config, adapter chain, `proxy.ts` vs deprecated `middleware.ts`, Edge runtime segments, wrangler compatibility date/flags/bindings/triggers, Node APIs unsupported on workerd, Worker size vs limits, startup risks; `vercel.json` regions/crons, `CRON_SECRET`, Build Output API freshness and function sizes vs 250 MB; env leaks, secrets, header posture (from the manifest), Purser setup and TS compatibility, dependency freshness. `--fix` applies safe fixes (cron sync, `_headers`, scripts). |
| `hypdriv analyze [--worker] [--routes]` | Cloudflare: Worker weight report (runs `wrangler deploy --dry-run --outdir` or reads an existing bundle, attributes bytes via the source map and the OpenNext esbuild metafile, lists largest modules/packages/duplicates and top-level `await`s). Vercel: function sizes from `.vercel/output` (after `vercel build`). Both: per-route JS/CSS (gzip) from the manifest and budget evaluation; writes the weights back into `.hypdriv/manifest.json`. |
| `hypdriv routes [--css] [--cache] [--csp]` | Table of routes with classification, revalidate, cache policy, CSP mode, hints count, JS/CSS weight, Purser atoms. |
| `hypdriv audit <headers|csp|cache|https|css|all> --url <base> [--anonymous] [--header …]` | Fetches routes from the manifest (or `--paths`) against a running server: grades security headers (A+ model), validates CSP syntax and nonce/hash coverage (HypDriv's declared `'unsafe-inline'` fallback for cached HTML on Node/Vercel is a warning), checks cache behaviour like a browser (repeat visits carry the first response's cookies; `x-vercel-cache` and planned Vercel CDN headers on Vercel), verifies HTTPS enforcement on an https deployment (`https`, part of `all`: pages, `/_hypdriv/health` and a content-hashed asset requested over `http://` must answer `301`/`308` to the same URL over https; the probes are anonymous so no gateway header or token travels in clear text; assets served before your code on Cloudflare need the zone's Always Use HTTPS or a Redirect Rule), and runs Purser's zero-override check in headless Chrome (`css`; pages answered with an error status or without evaluable CSS fail instead of passing vacuously). Requests carry a short-lived `x-hypdriv-audit` token signed with `HYPDRIV_INTERNAL_SECRET`, so your bot shield and rate limits let the audit through; `--anonymous` sends unsigned requests. |
| `hypdriv budget [--ci] [--snapshot] [--diff]` | Evaluates budgets from the manifest and the worker report, stores snapshots under `.hypdriv/snapshots`, prints Markdown diffs for PR comments. |
| `hypdriv csp hashes [--route <path>]` / `hypdriv csp suggest [--reports <file>]` / `hypdriv csp print` | Shows static route hashes, proposes allow-list additions from collected violation reports, prints the effective policy. |
| `hypdriv css build|check|watch` | Purser through the bridge with the config's options. |
| `hypdriv warm --url <base> [--concurrency 4] [--anonymous] [--header …]` | Fetches the configured warm routes (or all static routes), signed with the audit token. |
| `hypdriv bench --url <base> [--paths …] [--n 20] [--anonymous] [--header …]` | TTFB p50/p95 and cache status distribution per path, signed with the audit token. |
| `hypdriv deps [--update safe|major] [--only <name>]` | Dependency freshness across the workspace (npm registry): patch/minor/major classification, optional updates. |
| `hypdriv manifest [--validate]` | Prints or validates `.hypdriv/manifest.json`. |
| `hypdriv jobs run <name> --url <base>` / `hypdriv jobs list` | Sends a signed internal request to a job route (`HYPDRIV_INTERNAL_SECRET`; on Vercel cron jobs as `GET` with `CRON_SECRET`). |
| `hypdriv vitals [--days 7]` | p75 per route from Analytics Engine (`CF_ACCOUNT_ID`, `CF_API_TOKEN`). |
| `hypdriv agent` | Prints agent guidance for this project (what is configured, what to run). |

Add to CI:

```yaml
- run: pnpm build
- run: npx hypdriv doctor --ci
- run: npx hypdriv budget --ci
- run: pnpm preview & npx wait-on http://localhost:8787 && npx hypdriv audit all --url http://localhost:8787
```

On Vercel, audit the preview deployment (`--url https://<deployment>.vercel.app`) with `HYPDRIV_INTERNAL_SECRET` in the environment. Locally, `pnpm build && pnpm start` and `--url http://localhost:3000`.

**Private deployments.** `audit`, `bench`, `warm` and `jobs run` get through a gateway in front of the deployment with headers sent to the audited origin only (also from the headless Chrome of the CSS audit), never logged, independent of `--anonymous`:

| Gateway | Variables (environment, `.dev.vars`, `.env*`, `vercel pull`'s files) | Header |
| --- | --- | --- |
| Vercel Deployment Protection | `VERCEL_AUTOMATION_BYPASS_SECRET` | `x-vercel-protection-bypass` |
| Cloudflare Access (service token) | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | `CF-Access-Client-Id`, `CF-Access-Client-Secret` |
| Anything else (WAF gate, basic auth, …) | `HYPDRIV_ACCESS_HEADERS` (`name: value` lines — `\n`-separated on one line — or a JSON object) | as given |

`--header 'name: value'` (repeatable) adds more for one run; prefer the variable for secrets, so they stay out of shell history and process lists.

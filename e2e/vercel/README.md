# HypDriv live suite for Vercel

A Next.js 16 app with every HypDriv capability that applies on Vercel switched on, each backed by the Vercel service that upgrades it, plus a runner (`scripts/e2e.ts`) that verifies them against a real Vercel project. It is the Vercel counterpart of [`e2e/cloudflare`](../cloudflare/README.md): unit tests and `next start` cannot show what only a deployment shows — Routing Middleware and Functions as separate invocations, the Vercel CDN and its tag purge, ISR regeneration, Global Config propagation, Vercel Queues deliveries and retries, Vercel Cron authentication, WAF rate-limit rules, BotID and Vercel Image Optimization.

Everything runs on the **Hobby** plan.

## What it checks (41)

| Area | Checks |
| --- | --- |
| Platform | `/_hypdriv/health` services (Vercel CDN, tag purge, WAF, Global Config, Image Optimization, Queues) and the deployment id, http→https 308, functions and middleware in `iad1`, compression, immutable chunks and `vercel.json` header rules, 404 with security headers |
| Security | Security headers and hash CSP on static pages, per-request nonce on dynamic pages, CSP report intake (logged), shield (scanner paths, traversal, methods, URL length), automation UA block, Turnstile challenge with the per-environment site key, Turnstile solved in Chromium (test keys), per-instance (or Upstash) rate limit, the Vercel WAF rule through `@vercel/firewall`, BotID for scripts and in a browser, CSRF, encrypted sessions |
| Cache | Prerendered pages from the CDN (`x-hypdriv-cache: CDN`), RSC payloads separated from HTML, per-country CDN entries for `withVercelCdn` (and `BYPASS` + reason for a `vary` page), `withVercelCdn` purged by `revalidateTag()` and `revalidatePath()` from a function, time-based ISR, `revalidateTag()` with the CSP of the regenerated page, `revalidatePath()` inside the ISR interval |
| Performance | `Link` preloads and Speculation Rules, 103 Early Hints (skipped: Vercel sends none), `/_next/image` through Vercel Image Optimization |
| API | `defineRoute` validation, ETag/304, body limits; geo from Vercel's headers; `hypFetch` (external call, `E_TIMEOUT` with one retry against a slow upstream, how the platform fetch treats abort signals) |
| Routing | Static redirect rule; redirects, feature flags and maintenance mode (also over CDN-cached pages) flipped through Global Config without a redeploy (and back) |
| Jobs | Vercel Cron registered, `CRON_SECRET` enforced, a run triggered by Vercel (`crons/run`) reaching the job with its schedule; Vercel Queues delivery, redelivery with attempts `1,2`, `retry: 'none'` acknowledgement |
| Live | Polling mode without Durable Objects (`publish()` reports it, subscriptions answer 503 with the poll interval) |
| Observability | Web Vitals (with country), spans and request logs in the runtime logs |

Job outcomes, vitals and spans are read from the deployment's **runtime-logs stream** (Vercel REST API): the runner opens it before the first check, waits for a probe request to appear, and re-triggers an action whose line is missing (the stream is live-only and best-effort under bursts). No writable store is needed. Slow checks run concurrently; `revalidate-path` (timing-sensitive) and maintenance mode (site-wide) run alone at the end. A full run takes about 2½–3 minutes.

## Run it in your Vercel team

```sh
pnpm install && pnpm build                     # from the repository root
cd e2e/vercel

# 1. Project (root directory e2e/vercel, iad1), Vercel Authentication on every deployment plus a Protection
#    Bypass for Automation (the deployment stays private), secrets, a Global Config store + read token, the
#    WAF rate-limit rule, and the link `.vercel/project.json` at the repository root.
VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… pnpm provision --prefix acme-hypdriv \
  [--turnstile-site-key … --turnstile-secret-key …] [--dir <where the git-ignored files go>] [--public] [--domain …]

# 2. Build and deploy from the repository root (the project's root directory is e2e/vercel).
cd ../.. && vercel pull --yes --environment=production && vercel build --prod && vercel deploy --prebuilt --prod

# 3. Verify (against https://acme-hypdriv-vercel-e2e.vercel.app through the bypass).
cd e2e/vercel && source acme-hypdriv.vercel.e2e.local.env && VERCEL_TOKEN=… pnpm e2e   # e2e-report.json; exit 1 on failure
pnpm e2e --only queue,global-config-flags --json                      # a subset, machine-readable
pnpm e2e --logs runtime-logs.ndjson                                   # also keep every log line the run read
```

No custom domain is needed: the suite runs against the project's `.vercel.app` URL. Every request the runner (and its headless Chromium) sends to that host carries `x-vercel-protection-bypass`; requests to other hosts never do. Vercel's own invocations — cron runs, queue deliveries — are not affected by the protection. BotID answers `bypassed` for bypassed requests, which the `botid` check accepts.

### Optional checks

- **Upstash Redis.** Install Upstash from the Vercel Marketplace and connect it to the project (`KV_REST_API_URL`, `KV_REST_API_TOKEN`): `/api/limited` switches from per-instance to exact global counters and `health` reports it.
- **Turnstile pass flow.** Add the `.vercel.app` hostname to your Turnstile widget for real-key challenges, or set the project's `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` to Cloudflare's always-pass test keys (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`), redeploy, run `E2E_TURNSTILE=test E2E_TURNSTILE_SITE_KEY=1x00000000000000000000AA pnpm e2e --only bots-challenge,turnstile-pass`, then restore the real keys and redeploy (Vercel binds environment variables per deployment).

The browser checks (Turnstile, BotID) use Playwright's Chromium when it is installed (`require('playwright')`).

## Environment

| Variable | Used for |
| --- | --- |
| `E2E_URL` | the production deployment (`https://<project>.vercel.app`; the runner resolves its deployment id) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | passing Vercel Authentication on a private deployment (also `CF_ACCESS_CLIENT_ID` / `_SECRET` and `HYPDRIV_ACCESS_HEADERS` for other gateways) |
| `HYPDRIV_INTERNAL_SECRET` | signing control requests (`/api/enqueue`, `/api/publish`, `/api/revalidate`) |
| `CRON_SECRET` | calling the cron route the way Vercel Cron does |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `E2E_VERCEL_PROJECT` | runtime logs, Global Config writes, project and firewall reads |
| `E2E_GLOBAL_CONFIG_ID` | the Global Config store the app reads (`GLOBAL_CONFIG`) |
| `E2E_TURNSTILE`, `E2E_TURNSTILE_SITE_KEY` | optional checks |

The Vercel token never reaches the deployment: the app only holds a Global Config **read** token, and Vercel provides the bypass secret to the deployment itself. Checks whose inputs are missing are reported as skipped, never as passed.

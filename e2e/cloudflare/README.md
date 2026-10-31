# Hypdriv live suite for Cloudflare

A Next.js 16 app with every Hypdriv capability switched on, each backed by the binding that upgrades it, plus a runner (`scripts/e2e.ts`) that verifies them against a real Cloudflare account. Unit tests and `wrangler dev` cannot show what only production shows: colos and isolates, the Cache API on a zone, zone purges, Queues retries and dead letters, cron triggers, Analytics Engine ingestion, Workers Observability, tail consumers, 103 Early Hints, image resizing and Turnstile.

## What it checks (43)

| Area | Checks |
| --- | --- |
| Platform | `/_hypdriv/health` capabilities, http→https 308, compression and HTTP/3, immutable chunks and `public/_headers`, 404 with security headers |
| Security | Security headers and hash CSP on static pages, per-request nonce (every script allowed by nonce or hash) on dynamic pages, CSP report intake, shield (scanner paths, traversal, methods, URL length), automation UA block, Turnstile challenge with the per-environment site key, Turnstile solved in Chromium (test keys), Durable Object and binding rate limits, CSRF, encrypted sessions |
| Cache | Edge cache MISS→HIT, RSC payloads separated from HTML (Next 16 `_rsc` redirect), skew protection, time-based ISR through OpenNext's Durable Object queue and the Worker's pass-through, `revalidateTag()` a second after the first store (purge tombstones) with every script of the regenerated page allowed by its CSP, `revalidatePath()`, per-country variants, R2 incremental cache objects |
| Performance | `Link` preloads, zone Early Hints, HTTP/2 **103** responses, `/cdn-cgi/image` resizing and `/_next/image` through the Images binding |
| API | `defineRoute` validation, ETag/304, body limits; geo from `request.cf`; `hypFetch` |
| Routing | Static redirect rule; redirects, feature flags and maintenance mode flipped through KV without a redeploy (and back) |
| Jobs | Cron every minute, queue delivery, retry with attempts `1,2`, dead-letter queue consumer; email (skipped: needs Email Routing and an external sender) |
| Live | Server-Sent Events, WebSocket, polling fallback and channel stats |
| Observability | Web Vitals in Analytics Engine, spans in the same dataset, request logs in Workers Observability, tail consumer forwarding another Worker's warnings |

Slow checks (polling Queues, cron, Analytics Engine, Observability) run concurrently; maintenance mode, which changes the whole site, runs alone at the end. A full run takes about 40–110 seconds.

## Run it in your account

```sh
pnpm install && pnpm build                     # from the repository root
cd e2e/cloudflare

# 1. Resources: KV, R2 (enam), the jobs queue + its DLQ, a Turnstile widget, plus git-ignored config files.
#    --gate keeps it private: a zone WAF rule blocks HTTPS requests without the gate header/cookie, and with a
#    custom domain workers.dev stays off.
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  pnpm provision --prefix acme-hypdriv --domain e2e.acme.dev --zone <zone id> --rate-limit-namespace 9101 --gate
#    Add CACHE_PURGE_API_TOKEN (Zone → Cache Purge) to acme-hypdriv.secrets.local.json for zone purges.

# 2. Build and deploy (custom domain: the Cache API, regional cache and Early Hints need one).
pnpm exec opennextjs-cloudflare build -c wrangler.acme-hypdriv.local.jsonc
pnpm exec opennextjs-cloudflare deploy -c wrangler.acme-hypdriv.local.jsonc --secrets-file acme-hypdriv.secrets.local.json
pnpm provision --prefix acme-hypdriv --tag hypdriv-e2e       # optional: tag the Worker

# 3. Verify.
source acme-hypdriv.e2e.local.env && pnpm e2e                # writes e2e-report.json; exit 1 on failure
pnpm e2e --only queue,cron --json                            # a subset, machine-readable
```

Queue names must end in `-e2e-jobs` / `-e2e-jobs-dlq`: the app maps them with wildcards (`jobs.queues.jobs.queues: ['*-e2e-jobs']`), so each account names its own.

### Optional checks

- **Tail consumer.** Add `"tail_consumers": [{ "service": "<prefix>-e2e" }]` to another Hypdriv Worker and set `E2E_TAIL_PRODUCER_URL` to its URL.
- **Turnstile pass flow.** Switch the deployment to Cloudflare's always-pass test keys, run the browser check, switch back — a secret change, no redeploy, because the app reads the site key from `TURNSTILE_SITE_KEY` (`siteKeyEnv`):

  ```sh
  echo '{"TURNSTILE_SITE_KEY":"1x00000000000000000000AA","TURNSTILE_SECRET_KEY":"1x0000000000000000000000000000000AA"}' > /tmp/ts.json
  pnpm exec wrangler secret bulk /tmp/ts.json -c wrangler.acme-hypdriv.local.jsonc
  E2E_TURNSTILE=test E2E_TURNSTILE_SITE_KEY=1x00000000000000000000AA pnpm e2e --only bots-challenge,turnstile-pass
  # restore the real keys from acme-hypdriv.secrets.local.json the same way
  ```

  The browser check uses Playwright's Chromium when it is installed (`require('playwright')`).

## Environment

| Variable | Used for |
| --- | --- |
| `E2E_URL` | the deployed app (custom domain recommended) |
| `HYPDRIV_INTERNAL_SECRET` | signing control requests (`/api/state`, `/api/enqueue`, `/api/publish`, `/api/revalidate`) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | KV writes, R2 listing, Analytics Engine SQL, Workers Observability queries |
| `E2E_KV_NAMESPACE_ID`, `E2E_WORKER`, `E2E_R2_BUCKET`, `E2E_AE_DATASET`, `E2E_ZONE_ID` | the resources above |
| `E2E_TAIL_PRODUCER_URL`, `E2E_TURNSTILE`, `E2E_TURNSTILE_SITE_KEY` | optional checks |
| `HYPDRIV_ACCESS_HEADERS` (or `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`) | passing the gateway of a private deployment (`provision --gate` writes the first to the env file); sent over HTTPS to the suite's hosts only — also by Chromium and on the WebSocket upgrade |

Checks whose inputs are missing are reported as skipped, never as passed.

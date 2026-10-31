# Live Cloudflare test — 2026-10-30

Hypdriv tested on a real Cloudflare account (Free-plan zone, US-first: R2 `enam`, requests served from IAD/CMH). Everything created for the test is named `hypdriv-dev*`; the three Workers carry the `hypdriv-dev` tag (script settings) and every deployed version the `hypdriv-dev` version tag. Credentials stayed out of the repository: a scoped token (Zone → Cache Purge) was created for the Workers' `CACHE_PURGE_API_TOKEN`; the account token was used only from the operator's shell.

## What ran

| Worker | Custom domain | Contents |
| --- | --- | --- |
| `hypdriv-dev-basic` | `hypdriv-dev-basic.example-zone.dev` | `examples/basic` (Cache Components, PPR, KV, Durable Objects, Analytics Engine, Rate Limiting binding, Images, cron); tail producer for the suite |
| `hypdriv-dev-purser` | `hypdriv-dev-purser.example-zone.dev` | `examples/with-purser` |
| `hypdriv-dev-e2e` | `hypdriv-dev-e2e.example-zone.dev` | `e2e/cloudflare` (every capability on, queues + DLQ, cron every minute) |

Resources: KV namespaces `hypdriv-dev-{basic,purser,e2e}-kv`; R2 buckets `hypdriv-dev-{basic,purser,e2e}-cache` (`enam`); queues `hypdriv-dev-e2e-jobs` and `…-jobs-dlq`; Turnstile widget `hypdriv-dev` (managed, the test zone); Analytics Engine datasets `hypdriv_dev_{basic,purser,e2e}`; Rate Limiting namespaces 74010–74012; zone settings Early Hints and Image Resizing switched on (both were off; they only affect proxied hostnames, and the zone's other records are DNS-only). DNS records for the custom domains are managed by Workers (read-only), so they carry no tags; the zone plan has no DNS tags either.

All three Workers deploy with OpenNext's full cache setup (R2 incremental cache behind the regional Cache API cache, Durable Object queue, sharded Durable Object tag cache, Durable Object cache purge) next to Hypdriv's Durable Objects.

## Results

- **`hypdriv audit all`** over HTTPS on both examples: security headers A+ on every route, CSP hash/nonce correct on every route, edge cache HIT on every policy route; Purser zero-override audit 81 checks, 0 overrides. `hypdriv warm` 4/4, `hypdriv bench` (HIT p50 ≈ 20 ms from the test host), `hypdriv jobs run digest` signed and accepted, `hypdriv vitals` p75 per route from Analytics Engine, `hypdriv doctor` 72 pass / 0 fail.
- **Live suite** (`e2e/cloudflare`, 43 checks): 41 passed, 2 skipped (inbound email; Turnstile pass flow, which ran separately), 0 failed. With the always-pass test keys swapped in through `wrangler secret bulk`, Chromium solved the challenge and received the `HttpOnly; Secure; SameSite=Lax` clearance cookie; the real keys were restored the same way and the challenge page carried the real site key again.
- **103 Early Hints** observed over HTTP/2 from the second request on (Cloudflare learns the `Link` headers from the first response).

## Defects found and fixed

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | critical | Two apps built from one commit served **each other's pages**: Next 16 uses a constant `BUILD_ID` with `deploymentId`, OpenNext keys its caches by the deployment id, Hypdriv derived the id from the commit only, and the Cache API is shared per zone. The Purser app resumed `basic`'s PPR shell (client-render fallback, CSP hash mismatches); `basic` served Purser's home page. | Deployment ids are `<commit>-<build stamp>`, unique per build and app, shared across the build's processes (ADR 0016). `x-hypdriv-build`, health and logs report the content fingerprint and deployment id. |
| 2 | high | `revalidateTag()` left old pages at the edge: other isolates' memory tier kept copies for the whole TTL; Cache API copies in other colos had no `Cache-Tag` for zone purges; a response requested before the purge (or one Next rendered before applying its deferred revalidation) was stored after it. | Short-lived memory tier (`memoryTtl`, 10 s), `Cache-Tag` on Cache API copies, `path:` tags for every variant, purge tombstones in the Durable Object / memory / KV tag indexes with a 5 s grace window, a repeat purge after Next's commit (ADR 0017). Verified live by purging one second after the first store. |
| 3 | high | ISR never regenerated pages: OpenNext's queue, tag cache and purge default to no-ops and the examples/templates configured only the incremental cache. Once configured, the queue's revalidation requests would have run through the edge cache, bot shield and rate limits. | Examples and templates ship the full OpenNext cache setup; the Worker recognises revalidation requests by a hash of the preview-mode id (manifest, the id itself never stored) and sends them straight to Next, then purges the page's edge copies; `hypdriv doctor` checks overrides against bindings and exports (`opennext.cache`). |
| 4 | medium | Feature flags stayed on the last KV value after the KV key was deleted (per isolate, until restart). | A missing key means "no overrides": back to the config definitions; the last good value is kept only on read errors. |
| 5 | medium | `hypdriv vitals` would mix span rows into the report when tracing exports to the same Analytics Engine dataset. | The query only counts vitals metrics (`blob1 IN ('LCP', …)`). |
| 6 | medium | Queue consumers required the config key to equal the deployed queue name, which differs per environment. | `jobs.queues[name].queues` lists deployed names with `*` wildcards; batches report `job` and `queue`; doctor flags orphaned consumer queues and missing producers. |
| 7 | low | The tail handler ignored invocations that hit CPU/memory/wall-time limits or were cancelled without an exception. | Logged as `tail outcome` with script, path, cron or queue. |
| 8 | low | The Turnstile site key had to be a literal in `hypdriv.config`, so test keys and per-environment keys needed code changes. | `turnstile.siteKeyEnv` (default `TURNSTILE_SITE_KEY` when no literal key): a secret change switches keys. |
| 9 | low | The redirect stage needs `forceHttps` or an `https` `site.origin` to upgrade plain-HTTP requests on custom domains. | The e2e app sets `forceHttps: true`; the examples rely on their `https` origins (verified: 308). |

## Observations (no change needed)

- Node's `fetch` always sends `sec-fetch-mode: cors`; a script that adds `sec-fetch-dest: document` produces a combination no browser sends and the bot shield challenges it, as intended.
- Next 16 redirects RSC requests whose `_rsc` parameter does not match the router headers (307) and answers malformed `next-router-state-tree` headers with 500; Hypdriv passes both through unchanged.
- Certificate Transparency made the new hostnames visible to scanners within minutes (`/.env`, `/.git/HEAD`, `*.sql`, `wp-*`): the shield answered 404/403 before Next.js ran.
- Dynamic pages are not stored by the edge cache unless the policy sets `respectOrigin: false` (Next marks them `private, no-store`); documented in the caching guide.

## Not covered

Inbound email needs an Email Routing rule and an external sender; the handler and its route are in place (`jobs.email`). The real (non-test) Turnstile widget cannot be solved headlessly.

## Update 2026-10-31: private, re-verified

The three test Workers are no longer public. `workers.dev` is off (`"workers_dev": false`; with custom domains it was only a second, public door), and a zone WAF custom rule (`hypdriv-dev: private Hypdriv test Workers …`, every plan) blocks HTTPS requests to the three custom domains that carry neither the `x-hypdriv-gate` header nor the `hypdriv_gate` cookie; plain HTTP stays outside the rule because the Worker answers it only with `308` to HTTPS (which made a gap visible: internal routes and static assets used to be served over plain HTTP — fixed, see the [Vercel report](vercel-live-2026-10-31.md), defect 12). The runner and `hypdriv audit` send the header from `HYPDRIV_ACCESS_HEADERS`; `provision --gate` sets this up for any account. After the fixes from the Vercel run (tag-revalidated prerenders are `isr`, ADR 0018; never-awaited body cancels; the https upgrade), all three Workers were redeployed: suite 41 passed / 0 failed / 2 skipped through the gate (Turnstile pass flow with test keys: pass), audits on both examples: pass.


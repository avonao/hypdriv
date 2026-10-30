# HypDriv feature catalog

Every capability HypDriv adds to a Next.js 16+ application, grouped by the problem it solves. "Baseline" describes what works on a bare Worker (static assets binding only); "Upgrade" describes what an optional binding adds. Section 5 lists how each capability is delivered on Vercel, where platform services take the place of bindings. Package names tell you where the code lives.

Legend: ✅ implemented in this repository · 🧪 implemented, needs end-to-end validation in the example apps · 🧭 designed, implementation tracked in `docs/roadmap.md`.

## 1. Speed

| Feature                       | What it does                                                                                              | Baseline                               | Upgrade                                                      | Package                | Status |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ | ---------------------- | ------ |
| Edge full-response cache      | Caches eligible responses at the edge with TTL, SWR, stale-if-error, tags (incl. `path:`), coalescing and normalised keys; purges consistent across isolates, colos and in-flight requests (ADR 0017) | Cache API (per colo)                   | KV (global), `HypDrivIndex` DO for tag purge + tombstones, zone purge API (`Cache-Tag`) | `cache`, `cloudflare`  | ✅     |
| Cache policy inference        | Derives safe default policies from the build manifest (static / shell / dynamic / RSC)                    | ✅                                     | —                                                            | `cache`, `next`        | ✅     |
| Request coalescing            | Collapses concurrent misses for one key into a single upstream render                                     | per isolate                            | exact via DO lock                                            | `cache`                | ✅     |
| Early Hints (103)             | Emits per-route `Link: rel=preload/preconnect` from the manifest so Cloudflare sends 103 responses        | ✅                                     | —                                                            | `next`, `cloudflare`   | ✅     |
| Speculation Rules             | Injects per-route prerender/prefetch rules (document rules, eagerness, exclusions) with CSP-safe hashes   | ✅ (edge inject) / component elsewhere | —                                                            | `next`, `cloudflare`   | ✅     |
| Flashless themes              | Pins theme classes on `<html>` at the edge from cookie or `Sec-CH-Prefers-Color-Scheme`                   | ✅                                     | —                                                            | `purser`, `cloudflare` | ✅     |
| Resource hint composition     | Merges application `Link` headers, Purser stylesheet and font preloads without duplicates                 | ✅                                     | —                                                            | `core`                 | ✅     |
| Worker weight report          | Attributes bundle bytes to source modules via the source map; flags startup risks                         | ✅                                     | —                                                            | `cli`                  | ✅     |
| Budgets                       | Per-route JS/CSS budgets and Worker size budget with snapshots and PR-ready diffs                         | ✅                                     | —                                                            | `core`, `cli`          | ✅     |
| Skew protection assist        | Auto `deploymentId` unique per build and app (ADR 0016), header passthrough, reload instruction for stale RSC clients | ✅                                     | OpenNext skew protection                                     | `next`, `cloudflare`   | ✅     |
| Cache warming                 | Post-deploy and scheduled warming of hot routes                                                           | CLI                                    | scheduled handler                                            | `cli`, `cloudflare`    | ✅     |
| Image loader                  | Cloudflare Images loader for `next/image`, format negotiation, placeholders map                           | `/_next/image` via OpenNext            | Images binding / `/cdn-cgi/image`                            | `image`                | ✅     |
| ETag / 304 for route handlers | `defineRoute()` computes weak ETags for JSON responses                                                    | ✅                                     | —                                                            | `next`                 | ✅     |
| Fetch resilience              | `hypFetch` with timeouts, retries with jitter, circuit breaker, dedupe                                    | ✅                                     | —                                                            | `core`                 | ✅     |

## 2. Security

| Feature                     | What it does                                                                                                           | Baseline           | Upgrade                                                | Package                                 | Status |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ | --------------------------------------- | ------ |
| CSP autopilot               | Strict CSP: hash mode for static routes, nonce mode for dynamic routes, report-only rollout, collector and suggestions | ✅                 | Analytics Engine for report storage                    | `security`, `next`, `cloudflare`, `cli` | ✅     |
| Security headers preset     | A+ header set with safe defaults and per-route overrides                                                               | ✅                 | —                                                      | `security`                              | ✅     |
| Rate limiting               | Fixed window, sliding window, token bucket; IETF `RateLimit-*` headers                                                 | memory + Cache API | KV, `HypDrivLimiter` DO (exact), Rate Limiting binding | `security`, `cloudflare`                | ✅     |
| Bot shield                  | Verified bots allowed, heuristics, honeypots, `Sec-Fetch-*` checks, Turnstile challenge (per-environment site key via `siteKeyEnv`) | ✅                 | `cf.botManagement` scores                              | `security`                              | ✅     |
| WAF-lite shield             | Method allow-list, body size limits, path traversal and null-byte rejection, header sanity                             | ✅                 | —                                                      | `security`                              | ✅     |
| Safe Server Actions         | `safeAction()` with Standard Schema validation, guards, rate limits, Turnstile, idempotency, audit hooks               | ✅                 | KV/DO idempotency store                                | `security`, `next`                      | ✅     |
| Safe Route Handlers         | `defineRoute()` with validation, auth, rate limits, caching, ETag                                                      | ✅                 | —                                                      | `next`                                  | ✅     |
| Encrypted sessions          | AES-256-GCM cookie sessions, HKDF key derivation, rotation, sliding expiry                                             | ✅                 | —                                                      | `security`                              | ✅     |
| JWT & JWKS                  | HS256/RS256/ES256 verification and HS256/ES256 signing with cached JWKS                                                | ✅                 | —                                                      | `security`                              | ✅     |
| Signing utilities           | HMAC-signed URLs, cookies and internal requests                                                                        | ✅                 | —                                                      | `security`                              | ✅     |
| Webhook verification        | Stripe, GitHub, Standard Webhooks (Svix) signature checks with replay windows                                          | ✅                 | —                                                      | `security`                              | ✅     |
| Password hashing            | scrypt via `node:crypto` when available, PBKDF2-SHA-256 fallback, PHC strings                                          | ✅                 | —                                                      | `security`                              | ✅     |
| Secrets scan                | Build-time scan of client assets for key formats and leaked env values                                                 | ✅                 | —                                                      | `security`, `cli`                       | ✅     |
| Open-redirect guard         | `safeRedirect()` for `redirect()` targets                                                                              | ✅                 | —                                                      | `security`                              | ✅     |
| CSRF for route handlers     | Double-submit token + `Sec-Fetch-Site` validation                                                                      | ✅                 | —                                                      | `security`                              | ✅     |
| SRI                         | Enables Turbopack SRI and verifies integrity attributes in prerendered HTML                                            | ✅                 | —                                                      | `next`                                  | ✅     |
| Internal job authentication | Signed requests from `scheduled`/`queue` handlers to Route Handlers                                                    | ✅                 | —                                                      | `cloudflare`, `next`                    | ✅     |

## 3. Observability

| Feature            | What it does                                                                       | Baseline | Upgrade                             | Package                        | Status |
| ------------------ | ---------------------------------------------------------------------------------- | -------- | ----------------------------------- | ------------------------------ | ------ |
| Tracing            | Spans, W3C propagation, OTLP/HTTP and console exporters                            | ✅       | Analytics Engine exporter           | `observe`                      | ✅     |
| Structured logging | Request-scoped JSON logs, redaction, sampling                                      | ✅       | —                                   | `observe`                      | ✅     |
| Server-Timing      | Per-stage durations and outcomes                                                   | ✅       | —                                   | `core`, `observe`              | ✅     |
| Web Vitals         | Beacon endpoint with route/cache attribution and p75 reporting                     | logs     | Analytics Engine + `hypdriv vitals` | `observe`, `cloudflare`, `cli` | ✅     |
| Error hooks        | `instrumentation.ts` / `onRequestError` helpers                                    | ✅       | —                                   | `observe`, `next`              | ✅     |
| DevTools HUD       | In-app panel showing timings, cache decisions, CSP mode, flags, Purser diagnostics | ✅       | —                                   | `devtools`                     | ✅     |

## 4. Cloudflare-native capabilities

| Feature               | What it does                                                                                      | Baseline            | Upgrade                          | Package              | Status |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------- | -------------------- | ------ |
| Worker shell          | Drivetrain pipeline around OpenNext; internal routes; lazy Next loading                           | ✅                  | —                                | `cloudflare`         | ✅     |
| Scheduled jobs        | Cron triggers dispatched to Route Handlers with signed internal requests                          | ✅                  | —                                | `cloudflare`, `next` | ✅     |
| Queue consumers       | Queue batches dispatched to Route Handlers with ack/retry mapping; per-environment queue names (`queues: ['*-jobs']`), dead-letter consumers | —                   | Queues                           | `cloudflare`, `next` | ✅     |
| Email workers         | Inbound email dispatched to a Route Handler                                                       | —                   | Email routing                    | `cloudflare`         | ✅     |
| Tail handler          | Forwards tail events (exceptions, warn/error lines, CPU/memory/wall-time limits, cancellations) to log sinks | ✅                  | —                                | `cloudflare`         | ✅     |
| ISR pass-through      | OpenNext's revalidation requests (`x-prerender-revalidate`, verified by hash) bypass the Drivetrain; regenerated pages purge their edge copies | ✅ | DO queue | `cloudflare`, `next` | ✅ |
| OpenNext cache check  | `hypdriv doctor` verifies the incremental cache, queue, tag cache and purge overrides against bindings and Worker exports | ✅ | — | `cli` | ✅ |
| Live e2e suite        | `e2e/cloudflare`: an app plus runner that verifies 40+ capabilities on a real account (provisioning script included) | — | account | `e2e` | ✅ |
| Geo context           | Country, region, city, timezone, continent, ASN, colo exposed to the app                          | ✅                  | —                                | `cloudflare`, `next` | ✅     |
| Locale negotiation    | `Accept-Language` + geo + cookie negotiation, proxy stage                                         | ✅                  | —                                | `next`               | ✅     |
| Live channels         | Pub/sub with WebSocket hibernation and SSE, `useLive()` hook, server-component refresh on publish | polling transport   | `HypDrivChannel` DO              | `live`, `cloudflare` | ✅     |
| Edge feature flags    | Deterministic bucketing, geo/cookie/percentage rules, header propagation, QA overrides            | env/static provider | KV, OpenFeature (Flagship)       | `flags`              | ✅     |
| Edge redirects        | Redirect table evaluated before Next.js                                                           | config              | KV-backed table without redeploy | `cloudflare`         | ✅     |
| Maintenance mode      | Branded maintenance page toggled by env or KV                                                     | ✅                  | KV                               | `cloudflare`         | ✅     |
| Typed bindings access | `hyp().env` typed from `CloudflareEnv`, dev fallback via OpenNext                                 | ✅                  | —                                | `cloudflare`, `next` | ✅     |
| Background work       | `defer()` → `waitUntil`/`after()`, `enqueue()` → Queues, else a signed consumer-route call        | ✅                  | Queues                           | `cloudflare`         | ✅     |

## 5. Vercel

Detected from `VERCEL=1`, `vercel.json` / `.vercel` or `platform: 'vercel'` ([ADR 0013](adr/0013-deploy-targets.md), [guide](guides/vercel.md)). The stages run in Routing Middleware (`proxy.ts`), which `createProxy()` wires to `@hypdriv/vercel` automatically.

| Capability | On Vercel | Baseline | Upgrade | Package | Status |
| --- | --- | --- | --- | --- | --- |
| Edge cache | Policies expressed as `Vercel-CDN-Cache-Control` + `Vercel-Cache-Tag`: `next.config` route headers for pages (`withHypDriv`), `withVercelCdn()` for Route Handlers, the `edge-cache` stage plans the decision (`x-hypdriv-cache: CDN`) | ✅ | `CDN-Cache-Control` for a downstream CDN | `vercel`, `next` | ✅ |
| Tag purge | `revalidateTag()` / `purgeEdge()` purge Vercel's CDN (request-context API, REST with `VERCEL_TOKEN`), 16 tags per call, `Retry-After` aware | ✅ | — | `vercel`, `cache` | ✅ |
| Rate limiting | Same policies and headers | per instance | Upstash Redis (exact, global); Vercel WAF rules (`rate-limit-vercel`) | `vercel`, `security` | ✅ |
| Bot shield | Heuristics, honeypots, `Sec-Fetch-*`, Turnstile | ✅ | BotID (`botIdGuard()`, `verifyBotId()`) | `vercel`, `security` | ✅ |
| Flags, redirects, maintenance | KV-backed providers read Global Config | config / env | Global Config (read-only), Upstash Redis | `vercel`, `flags` | ✅ |
| Cron | Vercel Cron (`GET` + `Authorization: Bearer $CRON_SECRET`) accepted by `jobHandler`; `hypdriv init` syncs `vercel.json#crons` | ✅ | — | `next`, `cli` | ✅ |
| Queues | `enqueue()` → Vercel Queues; `queueConsumer()` with HypDriv's retry contract | signed consumer-route call | `@vercel/queue` | `vercel`, `cloudflare` | ✅ |
| CSP | Hash for static routes, nonce for dynamic routes; declared `'unsafe-inline'` fallback for ISR / PPR shells (no `HTMLRewriter`) | ✅ | — | `security` | ✅ |
| Geo | `x-vercel-ip-*` headers (country, region, city, coordinates, postal code, timezone) and the `x-vercel-id` region | ✅ | — | `next` | ✅ |
| Build integration | Classic prerender layout restored for Vercel's builder, chaining with Vercel's adapter (`NEXT_ENABLE_ADAPTER=1`), manifest traced into every function | ✅ | — | `next` | ✅ |
| Runtime registry | Config + platform env registered by `createInstrumentation()` for helpers outside a proxied request | ✅ | — | `core`, `next` | ✅ |
| Tooling | `doctor`/`analyze`/`init --platform vercel`, Build Output API and function-size checks, `x-vercel-cache` in cache audits, Deployment Protection bypass | ✅ | — | `cli` | ✅ |

Not available on Vercel (documented fallbacks): HTML transforms and edge nonce injection (HTMLRewriter), Durable Object live channels (polling transport), 103 Early Hints (preload `Link` headers instead), Workers Analytics Engine sinks (logs / OTLP).

## 6. Purser CSS

| Feature                        | What it does                                                                      | Package                | Status |
| ------------------------------ | --------------------------------------------------------------------------------- | ---------------------- | ------ |
| In-process build/watch         | Purser runs inside `withHypDriv`; diagnostics surface in build output and the HUD | `purser`, `next`       | ✅     |
| Unstyled-atom guard            | Build fails if prerendered HTML references classes missing from the stylesheet    | `purser`, `next`       | ✅     |
| Atom usage report              | Atoms per route, unused atoms, CSS weight per route                               | `purser`, `cli`        | ✅     |
| Flashless themes               | Edge-pinned theme classes; hashed inline fallback                                 | `purser`, `cloudflare` | ✅     |
| Zero-override audit            | Headless Chrome crawl running Purser's strike-count check                         | `purser`, `cli`        | ✅     |
| Layer coexistence              | Ordered `@layer` statement generation for Tailwind/legacy CSS                     | `purser`               | ✅     |
| Early Hints for the stylesheet | Purser stylesheet preloaded on every route                                        | `next`                 | ✅     |

## 7. Developer experience

| Feature                  | What it does                                     | Package          | Status |
| ------------------------ | ------------------------------------------------ | ---------------- | ------ |
| `hypdriv init`           | Detect, scaffold, wire (Cloudflare, Vercel, Node) | `cli`            | ✅     |
| `hypdriv doctor`         | 91 platform-aware checks with fixes              | `cli`            | ✅     |
| `hypdriv analyze`        | Worker weight + route assets                     | `cli`            | ✅     |
| `hypdriv routes`         | Manifest table                                   | `cli`            | ✅     |
| `hypdriv audit`          | Headers, CSP, cache, CSS audits                  | `cli`            | ✅     |
| `hypdriv budget`         | Budgets with snapshots and diffs                 | `cli`            | ✅     |
| `hypdriv csp`            | Hashes, suggestions                              | `cli`            | ✅     |
| `hypdriv css`            | Purser passthrough                               | `cli`            | ✅     |
| `hypdriv warm` / `bench` | Warming and benchmarking                         | `cli`            | ✅     |
| `hypdriv deps`           | Daily dependency freshness with safe auto-update | `cli`            | ✅     |
| `create-hypdriv`         | Scaffolder: Cloudflare or Vercel, with or without Purser; templates are the audited example apps; generated local secrets | `create-hypdriv` | ✅     |
| Owner audit tokens       | `audit`/`bench`/`warm` sign requests so the bot shield and rate limits let them through ([ADR 0015](adr/0015-owner-audit-tokens.md)) | `security`, `cli`, `purser` | ✅ |
| Testing kit              | Fake bindings, request builders, vitest presets  | `testing`        | ✅     |
| Agent skill              | `skills/hypdriv/SKILL.md` and `AGENTS.md`        | repo             | ✅     |

## 8. Deliberately not included

- A replacement image optimiser (OpenNext + Cloudflare Images and Vercel Image Optimization already cover it).
- A replacement for Next's Cache Components / ISR storage (OpenNext's incremental cache covers it; HypDriv layers an edge cache on top).
- A hosted service. HypDriv is code only.

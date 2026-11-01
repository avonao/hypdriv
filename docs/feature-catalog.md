# Hypdriv feature catalog

Every capability Hypdriv adds to a Next.js 16+ application — and, through the Vite hosts (section 6), to plain Vite apps, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext and Waku — grouped by the problem it solves. "Baseline" describes what works on a bare Worker (static assets binding only); "Upgrade" describes what an optional binding adds. Section 5 lists how each capability is delivered on Vercel, where platform services take the place of bindings. Package names tell you where the code lives.

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
| Route diff                    | `hypdriv routes --diff <manifest>` compares classifications, CSP mode, cache policies and prerendered paths (optionally weights) with an earlier build and exits 1 on routes that became more dynamic | ✅ | — | `cli` | ✅ |
| `cf` CLI config               | `cloudflare.config.ts` is read by evaluating it (stand-in for `cf/config`; entry never runs): doctor's Wrangler checks and `init` hints work for projects without a Wrangler file | ✅ | — | `cli` | ✅ |
| Skew protection assist        | Auto `deploymentId` unique per build and app (ADR 0016), header passthrough, reload instruction for stale RSC clients | ✅                                     | OpenNext skew protection                                     | `next`, `cloudflare`   | ✅     |
| Operator purge                | `hypdriv purge` / signed `POST /_hypdriv/purge` (host-bound token, 2 min, own payload prefix): purge by tag, path or whole build across every cache tier from outside the application | CLI + Worker route | Edge cache, tag index, zone purge | `cli`, `runtime`, `security`, `cloudflare` | ✅     |
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
| Vitals dashboard   | Token-protected `/_hypdriv/dash`: p75, rating split, trends and per-route table      | memory   | Analytics Engine SQL API            | `observe`, `runtime`, `security` | ✅   |
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
| Middleware-aware edge cache | `cache.edge.bypass` (cookies, headers, query) makes the edge cache skip requests a `middleware.ts` decides on, because the cache answers before the middleware; `hypdriv doctor` (`cache.middleware`) warns when a middleware sits behind an edge cache that bypasses nothing | ✅ | — | `cache`, `cli` | ✅ |
| Hash-CSP cache guard | `hypdriv doctor` fails (`opennext.cache`) when routes use a hash CSP and no incremental cache serves their prerendered HTML (the page would never hydrate) | ✅ | — | `cli` | ✅ |
| Config outside the project | `--wrangler <file>` / `HYPDRIV_WRANGLER_CONFIG` on every CLI command: check a generated or shared Wrangler config (per-Worker `infra/*.wrangler.jsonc`) against the project it deploys | ✅ | — | `cli` | ✅ |
| Wrangler environments | `--env <name>` / `HYPDRIV_WRANGLER_ENV`: `doctor` and `analyze` check `env.<name>` as Wrangler resolves it (bindings are not inherited); `wrangler.env-bindings` warns when an environment lacks binding kinds the top level declares | ✅ | — | `cli` | ✅ |
| Production guide | `docs/guides/production-cloudflare.md`: install from a release bundle, OpenNext production cache, policy, resources, secrets, area-Worker fleets, probes, launch checklist, troubleshooting | ✅ | — | docs | ✅ |
| Live e2e suites       | `e2e/cloudflare` (43 checks) and `e2e/vercel` (41 checks, Hobby plan): an app plus runner that verifies every capability on a real account, with provisioning scripts | — | account | `e2e` | ✅ |
| Geo context           | Country, region, city, timezone, continent, ASN, colo exposed to the app                          | ✅                  | —                                | `cloudflare`, `next` | ✅     |
| Locale negotiation    | `Accept-Language` + geo + cookie negotiation, proxy stage                                         | ✅                  | —                                | `next`               | ✅     |
| Live channels         | Pub/sub with WebSocket hibernation and SSE, `useLive()` hook, server-component refresh on publish | polling transport   | `HypDrivChannel` DO              | `live`, `cloudflare` | ✅     |
| Edge feature flags    | Deterministic bucketing, geo/cookie/percentage rules, header propagation, QA overrides            | env/static provider | KV, OpenFeature (Flagship)       | `flags`              | ✅     |
| Edge A/B experiments  | Weighted variants per flag, sticky assignment cookie, audience and traffic share, exposures per visitor, variant-aware edge cache keys, `hypdriv experiments` report with sample ratio check and per-variant Web Vitals | log exposures | Analytics Engine (`HYPDRIV_ANALYTICS`) | `flags`, `observe`, `cache`, `cli` | ✅     |
| Edge redirects        | Redirect table evaluated before the application; `forceHttps` (default on for Cloudflare and Vercel deployments, otherwise from `site.origin`) upgrades every plain-HTTP request that reaches Hypdriv (internal routes and static assets included) before anything answers; `hypdriv audit https` verifies pages, internal routes and hashed assets over `http://` | config              | KV-backed table without redeploy | `runtime`, `cloudflare`, `next` | ✅     |
| Maintenance mode      | Branded maintenance page toggled by env or KV                                                     | ✅                  | KV                               | `cloudflare`         | ✅     |
| Typed bindings access | `hyp().env` typed from `CloudflareEnv`, dev fallback via OpenNext                                 | ✅                  | —                                | `cloudflare`, `next` | ✅     |
| Background work       | `defer()` → `waitUntil`/`after()`, `enqueue()` → Queues, else a signed consumer-route call        | ✅                  | Queues                           | `cloudflare`         | ✅     |

## 5. Vercel

Detected from `VERCEL=1`, `vercel.json` / `.vercel` or `platform: 'vercel'` ([ADR 0013](adr/0013-deploy-targets.md), [guide](guides/vercel.md)). The stages run in Routing Middleware (`proxy.ts`), which `createProxy()` wires to `@hypdriv/vercel` automatically.

| Capability | On Vercel | Baseline | Upgrade | Package | Status |
| --- | --- | --- | --- | --- | --- |
| Edge cache | Policies expressed as `Vercel-CDN-Cache-Control` + `Vercel-Cache-Tag`: `next.config` route headers for pages (`withHypDriv`), `withVercelCdn()` for Route Handlers (with `Vary` for geo/language/device variants), the `edge-cache` stage plans the decision (`x-hypdriv-cache: CDN`; pages whose policy has no route-header form report `BYPASS` + `x-hypdriv-cache-reason`) | ✅ | `CDN-Cache-Control` for a downstream CDN | `vercel`, `next` | ✅ |
| Tag purge | `revalidateTag()` / `revalidatePath()` / `purgeEdge()` purge Vercel's CDN from Routing Middleware and Vercel Functions (purger registered by `createInstrumentation`, repeat purge under `waitUntil`; `path:` tags map to the CDN's `hyp:path:` tags), request-context API or REST with `VERCEL_TOKEN`, 16 tags per call, `Retry-After` aware | ✅ | — | `vercel`, `cache`, `next` | ✅ |
| Rate limiting | Same policies and headers | per instance | Upstash Redis (exact, global); Vercel WAF rules (`rate-limit-vercel`) | `vercel`, `security` | ✅ |
| Bot shield | Heuristics, honeypots, `Sec-Fetch-*`, Turnstile (site key per deployment env) | ✅ | BotID (`botIdGuard()`, `verifyBotId()`, default level `vercel.botId.checkLevel`) | `vercel`, `security` | ✅ |
| Flags, redirects, maintenance | KV-backed providers read Global Config (live within seconds; `config store` line in health) | config / env | Global Config (read-only), Upstash Redis | `vercel`, `flags` | ✅ |
| Cron | Vercel Cron (`GET` + `Authorization: Bearer $CRON_SECRET` + `x-vercel-cron-schedule`) accepted by `jobHandler`, job name and schedule from `jobs.cron` by path, secret env names from config; `hypdriv init` syncs `vercel.json#crons` | ✅ | — | `next`, `cli` | ✅ |
| Queues | `enqueue()` → Vercel Queues; `queueConsumer()` / `toQueueCallback()` with Hypdriv's retry contract (redelivery with attempts, `retry: 'none'` acknowledges) | signed consumer-route call | `@vercel/queue` | `vercel`, `cloudflare` | ✅ |
| CSP | Hash for static routes, nonce for dynamic routes; declared `'unsafe-inline'` fallback for ISR, tag-revalidated prerenders ([ADR 0018](adr/0018-tag-revalidated-prerenders.md)) and PPR shells (no `HTMLRewriter`) | ✅ | — | `security`, `next` | ✅ |
| Geo | `x-vercel-ip-*` headers (country, region, city, coordinates, postal code, timezone) and the `x-vercel-id` region | ✅ | — | `next` | ✅ |
| Build integration | Classic prerender layout restored for Vercel's builder, chaining with Vercel's adapter (`NEXT_ENABLE_ADAPTER=1`), manifest traced into every function | ✅ | — | `next` | ✅ |
| Runtime registry | Config, platform env and the Vercel CDN purger registered by `createInstrumentation()` for helpers outside a proxied request (`enqueue()`, `jobHandler`, `revalidatePath()`) | ✅ | — | `core`, `next` | ✅ |
| Outbound fetch | `hypFetch` timeouts settle the attempt even when the platform fetch ignores the abort signal; body cancels are never awaited (Next.js tees fetch bodies) | ✅ | — | `core` | ✅ |
| Observability | Request logs, spans (`tracing.exporter: 'console'`), Web Vitals (with the visitor's country) and CSP reports in the runtime logs / log drains | ✅ | OTLP | `observe`, `next` | ✅ |
| Tooling | `doctor`/`analyze`/`init --platform vercel`, Build Output API and function-size checks, `x-vercel-cache` in cache audits (platform limits reported as warnings), Deployment Protection bypass (also for `jobs run`), monorepo links at the repository root | ✅ | — | `cli` | ✅ |

Not available on Vercel (documented fallbacks): HTML transforms and edge nonce injection (HTMLRewriter), Durable Object live channels (polling transport), 103 Early Hints (preload `Link` headers instead), Workers Analytics Engine sinks (logs / OTLP), per-country CDN variants of pages (Route Handlers with `withVercelCdn` only), a dead-letter queue (`retry: 'none'` acknowledges), Skew Protection on Hobby (Pro feature).

## 6. Vite hosts

The same stages, manifest and CLI for Vite-based frameworks ([ADR 0019](adr/0019-vite-hosts.md)). Each integration wraps the framework's own request hook with `createHandler()` (the full response is Hypdriv's: CSP nonces are injected on every platform), builds the manifest after prerendering, patches it into the built server and writes static header rules for the platform.

| Feature | What it does | Package | Status |
| --- | --- | --- | --- |
| Neutral runtime | Stages, platform assembly per target, `createHandler()` for any Web fetch handler, `createProxyHandler()` for routing middleware, `hyp()` / `nonce()` / `flag()` / `jobHandler()` from the request context | `runtime` | ✅ |
| Neutral build engine | Manifest assembly (assets, CSP hashes, Early Hints, speculation graph, Purser, secrets, budgets, fingerprint) shared by the Next.js adapter and every Vite host | `build` | ✅ |
| Static header rules | Security preset, per-document hash CSP, Early Hints and immutable caching for responses the platform serves without code: Cloudflare `_headers` (merged, within limits, SPA-aware), Vercel Build Output routes | `build`, `vite` | ✅ |
| Portable nonce injection | Streaming, tokenizer-based nonce injection for HTML on runners without `HTMLRewriter` (framework hooks on Node and Vercel Functions); `modulepreload` links included | `security` | ✅ |
| Runtime manifest patch | Server bundles embed the manifest as a tagged literal, replaced with the final manifest after prerendering and the adapter ran | `vite` | ✅ |
| Plain Vite apps | `hypdriv()` plugin; `assetsWorker()` on Cloudflare, Build Output + Hypdriv Routing Middleware on Vercel, `hypdriv serve` on Node; dev/preview pipeline | `vite`, `cli` | ✅ |
| React Router 8 | `hypdriv()` Vite plugin + `hypdrivPreset()` (runs after prerendering), root `middleware`, nonce-aware `entry.server`; `reactRouterWorker()` on Cloudflare, a complete Build Output with traced per-config functions on Vercel, `hypdriv-react-router-serve` on Node; request-gating rules extended to `.data` requests | `react-router` | ✅ |
| TanStack Start | `tanstackStart(withHypDriv(...))` + `hypdriv()` Vite plugin, global request middleware (`hypdrivRequestMiddleware()`, CSRF kept), `ssr: hypdrivSsr()` nonces; `createStartWorker()` on Cloudflare, Nitro `vercel` / `node-server` presets | `tanstack-start` | ✅ |
| Astro 7 | Integration (`integrations: [hypdriv()]`) with `pre` middleware, injected `/_hypdriv/*` route, `withHypDriv()` for `src/fetch.ts`; Worker shell on Cloudflare, header routes on Vercel, `_headers.json` for `@astrojs/node`; defers to Astro's `security.csp` | `astro` | ✅ |
| SvelteKit 3 | `hypdriv(adapter())` wrapper + `sequence(hypdriv(), …)` hook; one policy merged with `kit.csp` (Hypdriv's nonce everywhere); Worker shell around adapter-cloudflare, adapter-vercel header routes, `@hypdriv/sveltekit/node` around adapter-node | `sveltekit` | ✅ |
| Nuxt 4 | `modules: ['@hypdriv/nuxt']`: Nitro plugin around the h3 app (error pages included), Nuxt-stamped nonces, `useHyp()`; Worker entry around Nitro's `cloudflare-module`, Vercel and Node presets | `nuxt` | ✅ |
| Hono 4 | `useHypDriv(app, { config })` middleware (or `wrapHono(app, { config })` around the whole app): the full Drivetrain on Workers, Vercel Functions, Node, Bun and Deno; `c.get('hypdrivNonce')` and `nonce()` for JSX; the route manifest derived from `app.routes`; `hypdriv init`, the `hono.*` doctor checks (registration, middleware order) and `create-hypdriv --framework hono` | `hono` | ✅ |
| vinext | `hypdriv()` around vinext's App Router entry (every runtime: `vinext start`, Workers, Nitro), `createVinextWorker()`, `withHypDrivCache()` purge bridge, CDN-served prerendered pages on Vercel | `vinext` | ✅ |
| Waku 1 | `withHypDriv()` in `waku.config.ts`: Waku's own Node, Vercel and Cloudflare adapters behind the Drivetrain (managed entry or your `src/waku.server.tsx`), the route manifest from `src/pages` and `createPage` calls, CSP hashes of prerendered pages and a nonce for the rest, `hyp()` / `nonce()` in server components, server functions and `_api` routes, Worker shell with Durable Objects on Cloudflare, clean-URL overrides and Routing Middleware on Vercel; `hypdriv init`, the `waku.*` doctor checks and `create-hypdriv --framework waku` | `waku` | ✅ |
| Prerendered pages on Vercel | Hypdriv's Routing Middleware scoped to the prerendered documents (GET/HEAD) so CDN-served pages get rate limiting, the bot shield, maintenance, redirects and geo; on-demand routes run the pipeline once, in the function | `vite` + every integration | ✅ |
| Private live verification | `e2e/hosts`: `check` (health, CSP coverage, nonces, asset caching, bot shield on rendered and prerendered pages, API, rate limit, HTTPS) and `provision` for private Cloudflare (one gate rule + HTTPS redirect per prefix) and Vercel (protection + automation bypass) deployments | `e2e/hosts` | ✅ |
| Framework-aware tooling | `doctor` detects the framework (Vite-host checks, Next-only checks skipped), `init` registers the integration in the framework's config and writes the platform files, `routes`/`manifest` show the framework, `audit` knows static-layer documents and endpoints, `serve` | `cli` | ✅ |

## 7. Purser CSS

| Feature                        | What it does                                                                      | Package                | Status |
| ------------------------------ | --------------------------------------------------------------------------------- | ---------------------- | ------ |
| In-process build/watch         | Purser runs inside `withHypDriv`; diagnostics surface in build output and the HUD | `purser`, `next`       | ✅     |
| Unstyled-atom guard            | Build fails if prerendered HTML references classes missing from the stylesheet    | `purser`, `next`       | ✅     |
| Atom usage report              | Atoms per route, unused atoms, CSS weight per route                               | `purser`, `cli`        | ✅     |
| Flashless themes               | Edge-pinned theme classes; hashed inline fallback                                 | `purser`, `cloudflare` | ✅     |
| Zero-override audit            | Headless Chrome crawl running Purser's strike-count check                         | `purser`, `cli`        | ✅     |
| Layer coexistence              | Ordered `@layer` statement generation for Tailwind/legacy CSS                     | `purser`               | ✅     |
| Early Hints for the stylesheet | Purser stylesheet preloaded on every route                                        | `next`                 | ✅     |

## 8. Developer experience

| Feature                  | What it does                                     | Package          | Status |
| ------------------------ | ------------------------------------------------ | ---------------- | ------ |
| `hypdriv init`           | Detect, scaffold, wire (Cloudflare, Vercel, Node) | `cli`            | ✅     |
| `hypdriv doctor`         | 100+ platform- and framework-aware checks with fixes | `cli`            | ✅     |
| `hypdriv analyze`        | Worker weight + route assets                     | `cli`            | ✅     |
| `hypdriv routes`         | Manifest table                                   | `cli`            | ✅     |
| `hypdriv audit`          | Headers, CSP, cache, HTTPS enforcement, CSS audits | `cli`            | ✅     |
| `hypdriv budget`         | Budgets with snapshots and diffs                 | `cli`            | ✅     |
| `hypdriv csp`            | Hashes, suggestions                              | `cli`            | ✅     |
| `hypdriv css`            | Purser passthrough                               | `cli`            | ✅     |
| `hypdriv warm` / `bench` | Warming and benchmarking                         | `cli`            | ✅     |
| `hypdriv deps`           | Daily dependency freshness with safe auto-update | `cli`            | ✅     |
| `create-hypdriv`         | Scaffolder: Cloudflare or Vercel, with or without Purser; templates are the audited example apps; generated local secrets | `create-hypdriv` | ✅     |
| Owner audit tokens       | `audit`/`bench`/`warm` sign requests so the bot shield and rate limits let them through ([ADR 0015](adr/0015-owner-audit-tokens.md)) | `security`, `cli`, `purser` | ✅ |
| Gateway access           | `audit`/`bench`/`warm`/`jobs run` pass private deployments: Vercel automation bypass, Cloudflare Access service tokens, `HYPDRIV_ACCESS_HEADERS` / `--header` for any other gate (origin only, never logged) | `cli` | ✅ |
| Testing kit              | Fake bindings, request builders, vitest presets  | `testing`        | ✅     |
| Agent skill              | `skills/hypdriv/SKILL.md` and `AGENTS.md`        | repo             | ✅     |

## 9. Deliberately not included

- A replacement image optimiser (OpenNext + Cloudflare Images and Vercel Image Optimization already cover it).
- A replacement for Next's Cache Components / ISR storage (OpenNext's incremental cache covers it; Hypdriv layers an edge cache on top).
- A hosted service. Hypdriv is code only.

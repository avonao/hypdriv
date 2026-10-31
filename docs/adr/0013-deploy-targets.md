# ADR 0013 — One runtime, three deploy targets: Cloudflare Workers, Vercel and Node hosts

**Status:** accepted · **Date:** 2026-10-30

## Context

Hypdriv was designed for Cloudflare Workers, where it owns the request in a Worker shell. Applications also deploy to Vercel, where the request is owned by Vercel's routing layer: `proxy.ts` runs as Routing Middleware *before* the CDN cache, functions render pages, and platform services (CDN, Upstash Redis, Global Config, WAF, BotID, Queues) replace Cloudflare bindings. Forking the pipeline per platform would double every stage and its tests.

## Decision

1. **A deploy target, detected twice.** `resolveBuildTarget()` decides at build time (config `platform`, then `VERCEL=1`, wrangler/OpenNext files, `vercel.json`/`.vercel`); `detectDeployTarget()` decides at run time (config, `VERCEL=1`, Vercel's request-context global, workerd). `platform: 'cloudflare' | 'vercel' | 'node'` in `hypdriv.config.ts` overrides both.
2. **One pipeline, platform overrides.** The Drivetrain and `createPlatform()` stay shared. `@hypdriv/vercel` supplies `vercelEnv()` (Global Config / Upstash as the KV binding, Upstash as `HYPDRIV_REDIS`, Vercel Queues producers), `vercelPlatformOverrides()` (capabilities and service descriptions, counter stores, WAF binding, purger) and `vercelStages()` (the Vercel CDN stage replaces `edge-cache` under the same name, `rate-limit-vercel` follows `rate-limit`, `html-transforms` is removed). `createProxy()` applies them automatically on Vercel.
3. **No Vercel SDK imports.** `@hypdriv/vercel` talks to services over `fetch` or Vercel's request-context global; SDK-only features (`@vercel/firewall`, `botid`, `@vercel/queue`) are registered by the application (`registerVercelSdk`). An uninstalled SDK can never break a build.
4. **CDN headers where Vercel's cache reads them.** Because middleware cannot set caching headers for Vercel's CDN, `withHypDriv` emits explicit policies as `next.config` `headers()` rules (`Vercel-CDN-Cache-Control`, `Vercel-Cache-Tag`) and `withVercelCdn()` wraps Route Handlers. The proxy stage still plans the decision (`x-hypdriv-cache: CDN`) for clients and downstream CDNs.
5. **Helpers outside a request context.** On Vercel, `proxy.ts` and functions are separate invocations, so `createInstrumentation().register()` and `createProxy()` register the process runtime (`registerRuntime({ config, env, target })`); `enqueue()` falls back to it, and to a signed consumer-route call when no queue producer is ready.
6. **CSP honesty.** Without `HTMLRewriter`, cached HTML (ISR, PPR shells) cannot carry a per-request nonce; Hypdriv sends its declared `'unsafe-inline'` fallback (`x-hypdriv-csp: unsafe-inline-fallback`) and the audit reports it as a warning rather than pretending otherwise. Static routes keep hash-based policies, dynamic routes nonces.

## Consequences

- Every stage, store and helper is exercised on both platforms by the same tests; platform differences live in one package and one detection function.
- Cloudflare-only capabilities (edge nonce injection, HTML transforms, Durable Object channels) degrade to documented fallbacks on Vercel, and `/_hypdriv/health`, `hypdriv doctor --platform vercel` and the HUD say which service backs each capability.
- New platforms follow the same recipe: an env augmenter, platform overrides, a stage adapter and a detection rule.

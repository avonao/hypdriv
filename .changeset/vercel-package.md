---
"@hypdriv/vercel": minor
---

New package `@hypdriv/vercel`: first-class Vercel support without runtime dependencies besides `@hypdriv/*`.

- `vercelCdnStage` replaces the `edge-cache` stage on Vercel and expresses edge-cache policies (explicit and manifest-inferred) as `Vercel-CDN-Cache-Control` / `CDN-Cache-Control`, `Vercel-Cache-Tag` (policy, route and `hyp:path:` tags, sanitised to Vercel's limits) and `Vary` headers, with negative caching and `Set-Cookie`/origin guards; `withVercelCdn` applies the same plan to Route Handler responses and `vercelCdnRouteHeaders` emits `next.config` `headers()` rules for pages, since Vercel's CDN caches function responses and Routing Middleware cannot set its caching headers.
- `vercelPurger`, `invalidateTags` and `deleteTags` purge Vercel CDN tags through the request-context purge API or the REST API (16 tags per call, one `Retry-After` retry on 429).
- `upstashKv` and `upstashCounterStore` (fixed/sliding windows via pipelines, token buckets via Lua) over Upstash REST; `globalConfigKv` reads Global Config (formerly Edge Config) with per-key caching, request coalescing and stale-if-error.
- `registerVercelSdk` for `@vercel/firewall`, `botid` and `@vercel/queue`; `vercelRateLimitBinding`, `vercelRateLimitRouter` and the `rate-limit-vercel` stage for Vercel WAF rules; `verifyBotId` and the `botIdGuard` safe-action guard; `vercelQueue` and `queueConsumer`/`toQueueCallback` for Vercel Queues with HypDriv's queue job contract.
- `vercelEnv`, `vercelPlatformOverrides` and `vercelStages` wire it into `createPlatform`/`createProxy`; `isVercel` and `vercelRequestContext` for detection.

---
"@hypdriv/core": minor
"@hypdriv/next": minor
"@hypdriv/cloudflare": minor
"@hypdriv/cache": minor
"@hypdriv/flags": patch
"@hypdriv/vercel": minor
"hypdriv": minor
---

Vercel as a first-class deploy target next to Cloudflare Workers.

- `@hypdriv/core`: `platform: 'auto' | 'cloudflare' | 'vercel' | 'node'` and the `vercel` config section, `detectDeployTarget()`, the process runtime registry (`registerRuntime`, `getRuntime`, `queueEnvKey`, `platformWaitUntil`), `isResolvedConfig()` (resolved configs carry a non-enumerable brand), `QueueLike.ready()`, `Capabilities.services` for platform service descriptions, `FLAGS_COOKIE_PENDING_KEY`, and `rate-limit-vercel` in the default stage order.
- `@hypdriv/next`: `createProxy()` wires `@hypdriv/vercel` automatically on Vercel (Global Config / Upstash bindings, Vercel CDN stage, WAF stage, Vercel purges registered for `revalidateTag()`/`purgeEdge()`) and registers the runtime; `createInstrumentation().register()` registers config + platform env for helpers outside a proxied request; `withHypDriv` emits Vercel CDN route headers from explicit edge-cache policies on Vercel builds.
- `@hypdriv/cloudflare`: `enqueue()` uses Cloudflare Queues, then a ready platform producer (Vercel Queues), then a signed consumer-route call (via `site.origin` or `VERCEL_URL`, with Vercel's automation bypass), and works outside a request context through the registered runtime.
- `@hypdriv/cache`: `CacheStatus` gains `CDN` (cached by the hosting platform's CDN from Hypdriv's headers).
- `@hypdriv/vercel`: accepts `hypdriv.config` input or resolved configs everywhere, exposes Vercel Queues producers to `enqueue()`, loads `.hypdriv/manifest.json` in `withVercelCdn` by default, and describes the Vercel services behind each capability in `/_hypdriv/health`.
- `hypdriv`: new `hypdriv/vercel` entry point.

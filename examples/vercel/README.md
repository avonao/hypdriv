# Hypdriv — Vercel example

Next.js 16 (Cache Components on) deployed to Vercel with Hypdriv, US-first (`iad1`).

```sh
pnpm install
cp .env.example .env.local   # or: vercel env pull .env.local
pnpm dev                     # next dev with the proxy running Hypdriv stages
pnpm build                   # next build (withHypDriv detects Vercel from vercel.json / VERCEL=1)
pnpm build:vercel            # vercel build → .vercel/output (Build Output API)
pnpm deploy                  # vercel deploy --prebuilt
pnpm hypdriv:doctor          # environment and configuration checks for Vercel
```

What the example shows:

| Feature | Where |
| --- | --- |
| Drivetrain stages in Routing Middleware (CSP, security headers, bots, rate limits, geo, flags, Speculation Rules) | `proxy.ts` (`createProxy` wires `@hypdriv/vercel` automatically) |
| CDN caching of pages by Hypdriv policy (`Vercel-CDN-Cache-Control`, `Vercel-Cache-Tag`) | `products` policy → `next.config` `headers()` via `withHypDriv` |
| CDN caching of a Route Handler by policy | `app/api/products/route.ts` (`withVercelCdn`) |
| Tag purge on Vercel's CDN | `revalidateTag('catalog')` / `purgeEdge` from `hypdriv/cache` |
| Vercel Cron with `CRON_SECRET` | `vercel.json#crons` → `app/api/jobs/digest/route.ts` (`jobHandler`) |
| Vercel Queues producer and consumer | `enqueue('emails', …)` in `app/contact/actions.ts`, `queueConsumer` in `app/api/queues/emails/route.ts` |
| Exact global rate limits | Upstash Redis when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are set |
| Flags, redirects, maintenance from Global Config | `GLOBAL_CONFIG` |

Vercel Queues is in beta; without `@vercel/queue` registered, `enqueue()` invokes the consumer route
directly (signed with `HYPDRIV_INTERNAL_SECRET`).

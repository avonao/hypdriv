/**
 * `hypdriv` — the Hyper-Extension for Next.js 16+ on Cloudflare Workers and Vercel.
 *
 * The root entry is runtime-neutral: config definition, types and core utilities. Integration points
 * live on subpaths:
 *
 * | Import | Used in |
 * | --- | --- |
 * | `hypdriv/config` | `next.config.ts` (`withHypDriv`) |
 * | `hypdriv/proxy` | `proxy.ts` (`createProxy`, `matcher`) |
 * | `hypdriv/cloudflare` | `hypdriv.worker.ts` (`createWorker`, `enqueue`) |
 * | `hypdriv/durable-objects` | `hypdriv.worker.ts` (Durable Object classes) |
 * | `hypdriv/vercel` | Route Handlers and `instrumentation.ts` on Vercel |
 * | `hypdriv/server` | Server Components, Route Handlers, Server Actions |
 * | `hypdriv/client` | Client Components |
 * | `hypdriv/cache` | `revalidateTag`, `revalidatePath`, `purgeEdge` |
 * | `hypdriv/instrumentation` | `instrumentation.ts` |
 * | `hypdriv/next`, `hypdriv/security`, `hypdriv/flags`, `hypdriv/live`, `hypdriv/observe`, `hypdriv/image`, `hypdriv/purser` | the full package APIs |
 */
export * from '@hypdriv/core';

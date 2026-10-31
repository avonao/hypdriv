/**
 * Hypdriv on Vercel: CDN cache headers and tag purge, Upstash Redis and Global Config stores, WAF rate limits,
 * BotID and Queues. `hypdriv/proxy` and `hypdriv/config` wire the platform automatically when the target is
 * Vercel; import from here for Route Handler helpers (`withVercelCdn`, `queueConsumer`, `botIdGuard`) and the
 * optional SDK registration (`registerVercelSdk`).
 */
export * from '@hypdriv/vercel';

---
"@hypdriv/core": minor
"@hypdriv/next": minor
"@hypdriv/cloudflare": minor
"@hypdriv/cli": minor
"create-hypdriv": minor
---

ISR on Cloudflare works end to end with OpenNext's full cache setup.

- `@hypdriv/next`: the adapter stores a SHA-256 of the build's preview-mode id in the manifest (`manifest.revalidation.tokenHash`; `previewModeId()`), and redacts the id from the proxy matcher conditions it records.
- `@hypdriv/cloudflare`: requests carrying `x-prerender-revalidate` with the build's id (OpenNext's revalidation queue through `WORKER_SELF_REFERENCE`) go straight to Next.js — no edge cache, bot shield or rate limit — and a regenerated page (`x-nextjs-cache: REVALIDATED`) purges its edge copies by `path:` tag. Other values run through the Drivetrain.
- `@hypdriv/cli`: `hypdriv doctor` check `opennext.cache` reads `open-next.config.ts` and verifies each override's binding (R2/KV/D1, `NEXT_CACHE_DO_QUEUE`, `NEXT_TAG_CACHE_DO_SHARDED`, `NEXT_CACHE_DO_PURGE`, `WORKER_SELF_REFERENCE`) and the Worker entry's Durable Object exports, and warns when ISR or tag revalidation would be no-ops.
- `create-hypdriv`: the Cloudflare templates ship the regional R2 incremental cache, the Durable Object queue, the sharded tag cache and the Durable Object cache purge, and never copy account-specific `wrangler.*.local.jsonc` files or local env files.

---
"@hypdriv/flags": patch
"@hypdriv/cli": patch
"@hypdriv/cloudflare": patch
---

Fixes from the live Cloudflare run:

- `@hypdriv/flags`: deleting the KV flags key returns to the config definitions; the KV provider kept serving the last KV value per isolate.
- `@hypdriv/cli`: `hypdriv vitals` counts only vitals rows, so spans exported to the same Analytics Engine dataset no longer appear as routes.
- `@hypdriv/cloudflare`: the tail handler logs invocations that ended abnormally without an exception (CPU, memory or wall-time limits, cancellations) as `tail outcome` with script, path, cron or queue.

---
"@hypdriv/core": minor
"@hypdriv/cloudflare": minor
"@hypdriv/cli": minor
---

Per-environment queue names: `jobs.queues[name].queues` lists the deployed Cloudflare queue names a job consumes (exact names first, then `*` wildcards; default: the key). `queueConsumerFor()` resolves a batch to its job; consumer routes receive `{ job, queue, messages }`. `hypdriv doctor` (`wrangler.queues`) reports consumer queues that map to no job, jobs without a consumer and producer bindings missing from `queues.producers`.

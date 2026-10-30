---
"@hypdriv/core": patch
"@hypdriv/next": patch
"@hypdriv/cache": patch
---

Edge-cache keys are scoped to a content fingerprint of the build output (`manifest.fingerprint`, `cacheVersion()`) instead of the build id alone. Next.js derives deterministic build ids from the deployment id, so a rebuild of the same commit with different output could be served HTML from the earlier output (stale chunk references, mismatched CSP hashes) from a persistent KV cache. `build:<id>` tags are unchanged. Found by an end-to-end rebuild on workerd.

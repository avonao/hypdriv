---
"@hypdriv/core": patch
"@hypdriv/cache": patch
"@hypdriv/cli": patch
---

`cache.edge.bypass`: cookies, headers and query parameters that make a request skip the edge cache for every policy, inferred ones included. The edge cache answers before OpenNext runs the application's `middleware.ts`, so a cached page skipped a cookie-based site gate (a page stored for an unlocked visitor was served to anonymous ones). `hypdriv doctor` gains `cache.middleware`, which warns when a build has a middleware, the edge cache has policies and no bypass is listed.

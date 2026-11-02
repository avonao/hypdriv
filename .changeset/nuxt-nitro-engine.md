---
"@hypdriv/nuxt": patch
---

`@hypdriv/nuxt` now runs on the Nitro 2 engine of `@hypdriv/nitro` (capture response, request hook, request helpers, prerendered paths and the Cloudflare Worker entry were duplicated inside the package). Behaviour is unchanged. The module bundles the engine like its own runtime files and aliases Hypdriv's packages in builds as well as in `nuxt dev`.

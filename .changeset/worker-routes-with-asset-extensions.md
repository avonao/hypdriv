---
'@hypdriv/cloudflare': patch
---

The Worker no longer skips the pipeline for a path that merely looks like a static asset when the application answers it: a route of the manifest such as `/feed.json` or `/sitemap.xml` (Route Handlers, SolidStart and RedwoodSDK endpoints, …) now runs the stages, so rate limits, the shield and bot rules apply to it. `/_next/static/` and genuine assets keep bypassing the pipeline.

---
"@hypdriv/observe": patch
---

`web-vitals` is a dependency instead of an optional peer: bundlers resolve the client reporter's dynamic import at build time, so a fresh install without it failed `next build` with "Module not found". It still loads as a separate chunk, with the `PerformanceObserver` fallback when the chunk cannot load. Found by building an app scaffolded with `create-hypdriv` against the packed packages.

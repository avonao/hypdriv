---
"@hypdriv/image": patch
---

The WebP placeholder encoder drives `@jsquash/webp`'s Emscripten module directly instead of importing its `encode.js`. That file pulls in `wasm-feature-detect`, whose 1.10 release uses `import.source(…)`, which Node 20 and 22 cannot parse, so WebP placeholders silently fell back to PNG there. Each glue file is now also paired with its own `.wasm` (SIMD or baseline).

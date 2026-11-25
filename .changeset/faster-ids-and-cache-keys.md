---
'@hypdriv/core': patch
'@hypdriv/cache': patch
---

A request's random values (its id, the CSP nonce, the trace and span ids) are drawn from a pool that is filled a kilobyte at a time, instead of one call into the platform's generator each, and the edge cache remembers the SHA-256 of the key materials it hashed last, so a page that is asked for again is not hashed again. On the benchmark in `benchmarks/` (Node, the built packages) the pipeline's cost per request went from 0.72 ms to 0.64 ms and a cache hit from 0.86 ms to 0.70 ms. `uuidv7()` writes its timestamp without `BigInt`.

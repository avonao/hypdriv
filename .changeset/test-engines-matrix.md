---
---

Tests: the root Vitest config runs each package's tests only on the Node versions its `engines.node` accepts (the Node 20 CI job no longer runs the Node 22+ Fastify WebSocket tests, which need the global `WebSocket`). `HYPDRIV_TEST_ALL_ENGINES=1` runs every package.

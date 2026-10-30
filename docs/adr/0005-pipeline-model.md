# ADR 0005 — One explicit pre/post stage pipeline shared by Worker and proxy

**Status:** accepted · **Date:** 2026-10-30

## Context

The same concerns (ids, shielding, limits, flags, cache, CSP, headers, hints) must run at the edge and in `proxy.ts`. Proxy cannot transform response bodies; the Worker can.

## Decision

`@hypdriv/core` defines `Stage { name, pre?, post?, edgeOnly? }` and `runPipeline(stages, ctx, next)`. `pre` runs in order and may short-circuit; `post` runs in reverse order with the response. Stages marked `edgeOnly` are skipped by the proxy runner. Stage timings are recorded automatically for `Server-Timing`.

## Consequences

- Features are implemented once and composed in both runners.
- Ordering is explicit and testable; the default order is documented in `architecture.md`.

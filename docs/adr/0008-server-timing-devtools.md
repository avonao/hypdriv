# ADR 0008 — Server-Timing is the transport for DevTools

**Status:** accepted · **Date:** 2026-10-30

## Context

An in-app HUD needs per-request data (stage timings, cache decision, CSP mode, flags). Adding endpoints or inline JSON couples the HUD to the Worker and pollutes HTML.

## Decision

Every stage reports a `Server-Timing` entry. The browser exposes those entries through `PerformanceNavigationTiming.serverTiming` and `PerformanceResourceTiming.serverTiming` (same origin), so the HUD reads them without any endpoint. Detailed entries are emitted in development and preview; production emits a compact set unless `observe.serverTiming: 'verbose'`.

## Consequences

- Zero HTML pollution; works with hash-based CSP.
- Server-Timing values are visible to users in production; secrets never go there.

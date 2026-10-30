# ADR 0003 — Build artifacts are read at run time, never baked into the same build

**Status:** accepted · **Date:** 2026-10-30

## Context

CSP hashes, Early Hints, speculation graphs and cache policies depend on the build output. `proxy.ts` and route code are compiled _by_ that build. Baking derived data into `next.config.ts` would require two passes or stale data.

## Decision

All derived knowledge lives in `.hypdriv/manifest.json`. The Worker shell imports it at bundle time (wrangler runs after `next build`). The proxy composables read it lazily from disk on the Node runtime and cache it in memory. The CLI reads it from disk.

## Consequences

- A single `next build` suffices; no circularity.
- In `next dev`, the manifest is absent or stale; stages fall back to safe generic behaviour (nonce CSP for all routes, no Early Hints) and the DevTools HUD says so.

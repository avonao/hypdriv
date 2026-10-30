# ADR 0001 — HypDriv is a sidecar that uses only public contracts

**Status:** accepted · **Date:** 2026-10-30

## Context

Tools that speed up or harden Next.js often do so by patching framework internals (webpack/Turbopack chunk templates, server internals, OpenNext's emitted code). Those approaches break on every minor release and make adoption risky.

## Decision

HypDriv attaches only through public, documented contracts:

1. `next.config.ts` (async configuration function),
2. the stable Adapter API (`adapterPath`, `modifyConfig`, `onBuildComplete`),
3. `proxy.ts`,
4. the Worker entry (`wrangler.jsonc#main`),
5. application code (imports from `@hypdriv/*`).

It never patches `next`, `@opennextjs/*` or `wrangler`, never reads undocumented internals at run time, and reads build output files only where Next.js documents them (`app-build-manifest.json`, `build-manifest.json`, prerendered HTML).

## Consequences

- Compatibility work concentrates at five seams and is testable with fixture builds.
- Some optimisations that require internal hooks (for example rewriting Next's own chunk loading) are out of scope; HypDriv achieves its goals at the HTTP and HTML layers instead.

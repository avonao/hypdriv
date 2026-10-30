# ADR 0002 — Build knowledge comes from a chained Next.js adapter

**Status:** accepted · **Date:** 2026-10-30

## Context

HypDriv needs a reliable description of the application after a build: routes, prerender classification (`compute: static | resuming | blocking`), assets per route, proxy matchers, static files. Next.js 16.2 made the Adapter API stable and typed. An application can configure only one `adapterPath`, and deployment platforms (Vercel, Bun, future OpenNext adapters) use it too.

## Decision

`withHypDriv` sets `adapterPath` to HypDriv's adapter and remembers the application's own adapter (explicit option, pre-existing `adapterPath`, or `NEXT_ADAPTER_PATH`) in `HYPDRIV_BASE_ADAPTER`. HypDriv's adapter delegates `modifyConfig` and `onBuildComplete` to the base adapter first, then derives its manifest. If no base adapter exists, HypDriv's adapter runs alone.

## Consequences

- Platform adapters keep working unchanged.
- HypDriv's manifest is generated during `next build`, which OpenNext runs before its own bundling, so the Worker bundle can import the manifest.
- Adapter output is versioned by Next.js; breaking changes arrive only with Next majors, which bounds HypDriv's maintenance surface.

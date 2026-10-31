# ADR 0011 — The Worker entry wraps OpenNext's worker and re-exports its Durable Objects

**Status:** accepted · **Date:** 2026-10-30

## Context

OpenNext generates `.open-next/worker.js` exporting `{ fetch }` and three Durable Object classes. Wrangler bundles whatever `main` points to.

## Decision

`hypdriv.worker.ts` becomes `main`. It re-exports OpenNext's Durable Objects (so existing bindings keep working), exports Hypdriv's own Durable Objects, and default-exports `createWorker({ config, next: () => import('./.open-next/worker.js'), manifest: () => import('./.hypdriv/manifest.js') })`. The OpenNext worker is imported lazily on first non-internal request.

## Consequences

- `opennextjs-cloudflare build/preview/deploy` keep working unchanged.
- Startup cost of the shell is independent of application size.
- `scheduled`, `queue`, `email` and `tail` handlers become available to Next.js applications.

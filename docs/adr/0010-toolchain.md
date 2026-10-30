# ADR 0010 — Toolchain

**Status:** accepted · **Date:** 2026-10-30

## Decision

- **pnpm** workspaces with a version catalog.
- **tsdown** (rolldown) for bundling and declaration output; ESM only.
- **vitest 4** with per-package projects; Workers-runtime tests through `@cloudflare/vitest-pool-workers`.
- **biome** for lint and format.
- **changesets** with linked versions.
- **TypeScript 6** inside the repository (stable programmatic API for tooling); host apps may use 5.9–7.x.
- Workspace packages expose a `source` export condition pointing at `src/`, enabled in vitest and `tsconfig.customConditions`, so tests and type checks run without a prior build.

## Consequences

- Fast builds and tests; one version number per release.
- Published packages contain `dist/` only, with `exports` maps and `publint` checks.

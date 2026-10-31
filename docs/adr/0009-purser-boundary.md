# ADR 0009 — Purser is consumed through its build API only

**Status:** accepted · **Date:** 2026-10-30

## Context

Purser CSS (`@avonao/purser`) is developed in its own repository. Hypdriv should make it first-class without creating a bidirectional dependency.

## Decision

`@hypdriv/purser` uses `@avonao/purser/build` (`build`, `check`, `watch`, `createBuilder`) and the published `scripts/strike-count.js`. It parses Purser's output stylesheet only to extract class names and atom groups. It treats `@avonao/purser` as an optional peer dependency and degrades to "Purser not installed" diagnostics.

## Consequences

- Purser evolves independently; Hypdriv tracks its public API.
- Purser needs TypeScript's programmatic API (TS ≤ 6 at the time of writing); the bridge detects TS 7 hosts and points to the `@typescript/typescript6` alias.

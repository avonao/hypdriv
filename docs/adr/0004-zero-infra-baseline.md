# ADR 0004 — Every feature has a zero-infrastructure mode; bindings are upgrades

**Status:** accepted · **Date:** 2026-10-30

## Context

The requirement is "works out of the box on Cloudflare Workers, no special infrastructure". OpenNext itself needs only the static assets binding (and optionally R2/DO/D1 for ISR).

## Decision

Each capability defines a _baseline_ that needs nothing beyond the Worker (memory, Cache API, request properties, `waitUntil`) and _upgrades_ that use optional bindings detected at startup through a capability probe (`detectCapabilities(env)`). Behaviour differences between baseline and upgrade are documented in the feature catalog and reported by `hypdriv doctor`.

## Consequences

- Rate limiting is approximate per colo by default and exact with the `HypDrivLimiter` Durable Object or the Rate Limiting binding.
- Tag purge is best-effort (TTL/SWR bounded) by default and exact with a tag index.
- Live channels fall back to polling without Durable Objects.

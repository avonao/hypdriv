# ADR 0012 — Live features use a Durable Object with hibernation and an SSE/polling fallback

**Status:** accepted · **Date:** 2026-10-30

## Context

Next.js has no built-in realtime story on serverless platforms. Durable Objects offer coordination and WebSocket hibernation at negligible cost, but they are an optional binding.

## Decision

`HypDrivChannel` (a Durable Object with SQLite storage) implements pub/sub per channel with the WebSocket Hibernation API and an SSE endpoint. `publish()` from server code calls the stub; `useLive()` in the browser connects over SSE (default) or WebSocket. Without the binding, the client falls back to polling a Route Handler and `publish()` becomes a no-op that logs once.

## Consequences

- Real-time server-component refresh (`router.refresh()` on publish) works on any plan with Durable Objects.
- Applications without DOs still build and run.

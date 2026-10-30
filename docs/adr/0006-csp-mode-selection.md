# ADR 0006 — CSP uses hashes for static routes and nonces for dynamic routes

**Status:** accepted · **Date:** 2026-10-30

## Context

A nonce-based strict CSP forces every page to render per request, which defeats static prerendering and edge caching. Hash-based CSP works for static HTML but not for streamed inline scripts whose content varies.

## Decision

The manifest classifies routes. Fully static routes (`compute: 'static'`) get a hash-based policy computed from their prerendered HTML and delivered as a response header, keeping them cacheable. Shell and dynamic routes get a nonce-based policy delivered through request headers so Next.js applies the nonce to its inline scripts. Both modes share the same directive set and can run in report-only mode first.

## Consequences

- Static routes keep full CDN cacheability with a strict CSP.
- Speculation Rules and theme fallback scripts are hashed into the static policy and nonced in the dynamic one.
- When no manifest is present (dev), nonce mode is used everywhere.

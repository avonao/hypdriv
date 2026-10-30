# ADR 0007 — Edge cache keys are normalised and include the build id

**Status:** accepted · **Date:** 2026-10-30

## Context

Naive URL keys fragment caches (tracking parameters, header case, trailing slashes) and can serve content from a previous deployment.

## Decision

Keys are built from: method, lowercase host, pathname normalised per Next's `trailingSlash`, sorted query without tracking parameters, selected vary dimensions (headers, cookies, geo, flags), RSC markers (`RSC`, `Next-Router-State-Tree`, `Next-Url`), and the build id. Keys are hashed (SHA-256, base64url) into a synthetic URL for the Cache API.

## Consequences

- Deployments never serve mixed content.
- Policies declare exactly which dimensions fragment the cache.

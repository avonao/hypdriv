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

## Amendment (2026-10-30): edge nonce injection and ISR

Prerendered pages that revalidate (`isr`) and partially prerendered shells are served from caches, so their inline scripts change between builds and cannot be hashed at build time, and Next.js cannot apply a nonce because it does not render them per request. On Cloudflare Workers the `csp` stage therefore **injects a per-request nonce** into every `<script>` element of HTML responses with `HTMLRewriter` and emits the matching nonce policy; Next-rendered HTML already carries the same nonce (it is passed in the request CSP header), so the transform is idempotent. Immutable `static` routes keep hash mode on the edge to avoid the transform. On non-edge runtimes (`proxy.ts` on Node), `isr`/`shell` routes fall back to `script-src 'self' 'unsafe-inline'` and the response is marked `x-hypdriv-csp: unsafe-inline-fallback`; this is the known limitation strict CSP has always had with cached HTML outside the edge.

Because the injection must happen after the edge cache stored the raw body, `csp` precedes `edge-cache` in the default stage order (its `post` runs after the cache's `post`).

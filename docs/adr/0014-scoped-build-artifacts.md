# ADR 0014 — Restore the classic prerender layout and ship the manifest with every function

**Status:** accepted · **Date:** 2026-10-30

## Context

Since Next.js 16.4, configuring any adapter switches the build to *scoped artifacts*: prerendered HTML, RSC payloads and metadata go to `.next/server/route-cache/<KIND>/<sha256>/$/…` instead of `.next/server/app/**`. Hypdriv installs an adapter only to observe the build (ADR 0002), yet that alone changes the layout. Deployment tooling that reads the classic layout — OpenNext's cache population and Vercel's legacy builder — then finds no prerenders: on workerd, Cache Components pages render on demand without their prerendered data; on Vercel, prerenders and PPR fallbacks are missing from `.vercel/output`.

Separately, the Hypdriv manifest must be readable at run time by every function (proxy, Route Handlers, server helpers), not only by the Worker shell.

## Decision

- After a build without a downstream adapter, Hypdriv **mirrors** every scoped artifact to its classic path (`$/blog.html` → `server/app/blog.html`, `PAGES` → `server/pages`), in `.next/server` and in every standalone copy. Existing files are never overwritten; `.meta` files keep their `routeCache.key`, so tools that understand scoped keys key entries identically. A custom adapter module built with `createAdapter({ mirrorScopedArtifacts: false })` (passed as `withHypDriv(config, { adapterPath })`) opts out.
- With a downstream adapter (OpenNext's, or Vercel's via `NEXT_ENABLE_ADAPTER=1` → `NEXT_ADAPTER_PATH`), Hypdriv **chains** it: the downstream adapter receives the build context unchanged plus the manifest files as extra assets, and handles the layout itself.
- Without a downstream adapter, Hypdriv **adds `.hypdriv/manifest.json` and `manifest.js` to the server traces** (`*.nft.json`), so Vercel and standalone deployments ship them with every function.

## Consequences

- OpenNext ≥ 1.20 and Vercel's builder work unchanged on Next.js 16.4 with Hypdriv installed, verified by `opennextjs-cloudflare build` + `populateCache` + `wrangler dev` and by `vercel build` in the example apps.
- The mirroring is a no-op on Next.js < 16.4 and on builds without scoped artifacts.
- A future Next.js release that lets observer-only adapters keep the classic layout makes the mirroring redundant, not wrong.

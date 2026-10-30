# ADR 0016 — Deployment ids are unique per build and per app

**Status:** accepted · **Date:** 2026-10-30

## Context

`withHypDriv` set Next.js's `deploymentId` for skew protection and derived it from the commit (`git rev-parse --short HEAD` or a CI SHA). Two consequences surfaced on a live Cloudflare account:

- Next.js 16 uses a **constant** `BUILD_ID` (`build-TfctsWXpff2fKS`) whenever `deploymentId` is set, and OpenNext keys its incremental cache, regional cache (Cache API) and tag caches by `deploymentId ?? BUILD_ID`.
- The Cache API is shared by every Worker on a zone. Two apps built from the same commit (a monorepo) and deployed to the same zone read each other's regional-cache entries: the `examples/basic` Worker served the Purser example's home page, and the Purser Worker resumed a PPR shell that belonged to `basic` ("Expected the resume to render `<Suspense>` in this slot but instead it rendered `<div>`"), falling back to client rendering with CSP-hash mismatches.

The same collision happens when one commit is deployed twice with different environment variables (`NEXT_PUBLIC_*`), where the second deployment can be served pages that reference the first deployment's chunks.

## Decision

- `defaultDeploymentId()` returns `<commit>-<build stamp>`: the CI commit SHA or git HEAD (10 characters, `build` outside both) plus base-36 seconds and four random characters. It is unique per build and per app.
- The id is computed once per build and shared with every process of that build (Next.js evaluates `next.config` in the main process and again in build workers) through `__HYPDRIV_BUILD_DEPLOYMENT_ID`, scoped by a hash of the project directory so a process tree that builds several apps gives each its own id.
- `HYPDRIV_DEPLOYMENT_ID` is used verbatim (sanitised to Next's `[a-zA-Z0-9_-]`, at most 64 characters). A constant `performance.skewProtection.deploymentId` in `hypdriv.config` is reported by `hypdriv doctor` as a warning.
- The response header `x-hypdriv-build`, `/_hypdriv/health` and startup logs report the content fingerprint (`cacheVersion()`) and the deployment id instead of Next's constant build id.

## Consequences

- Every deployment gets fresh OpenNext cache namespaces; nothing is shared across apps or across builds of the same commit. Caches start cold after each deploy, as they do on Vercel, where deployment ids are per deployment too.
- Skew protection (`x-deployment-id`, `?dpl=`) distinguishes deployments that share a commit.
- Reproducible-build setups that need a fixed id set `HYPDRIV_DEPLOYMENT_ID` themselves and own its uniqueness.

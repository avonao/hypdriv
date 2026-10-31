# ADR 0007 — Edge cache keys are normalised and include the build id

**Status:** accepted · **Date:** 2026-10-30

## Context

Naive URL keys fragment caches (tracking parameters, header case, trailing slashes) and can serve content from a previous deployment.

## Decision

Keys are built from: method, lowercase host, pathname (see the 2026-10-31 amendment for the trailing slash), sorted query without tracking parameters, selected vary dimensions (headers, cookies, geo, flags), RSC markers (`RSC`, `Next-Router-State-Tree`, `Next-Url`), and the build id. Keys are hashed (SHA-256, base64url) into a synthetic URL for the Cache API.

## Consequences

- Deployments never serve mixed content.
- Policies declare exactly which dimensions fragment the cache.

## Amendment (2026-10-30): keys use the build *fingerprint*

Next.js derives deterministic build ids from the deployment id (Hypdriv derives that from the git commit), so two different outputs of the same commit — an uncommitted rebuild, a changed environment variable, a dependency bump without a commit — share a `buildId`. A persistent store (KV) would then serve HTML that references the other output's chunks and CSP hashes. Keys therefore use `manifest.fingerprint` (`cacheVersion()`): a hash of the build id, the deployment id, every route's content-hashed client assets, the CSP hashes of prerendered HTML, Hypdriv's inline-script hashes and the Purser stylesheet. The `build:<buildId>` tag is unchanged, so build-wide purges still address the deployment.

## Amendment (2026-10-31): the trailing slash is part of the key

The key used to normalise the pathname to the Next `trailingSlash` setting, so `/legal` and `/legal/` shared an entry. With Next's `trailingSlash` one of the two is always a redirect to the other, and the default cacheable statuses include 301 and 308: on an empty cache whichever form was requested first decided what both returned, and `/legal/` could answer `308 → /legal/` for as long as the entry lived. The key now keeps the trailing slash as requested (`hypdriv-key/2`). `path:` tags still strip it, so a purge by path clears both forms, `purgeUrls` deletes both keys, and a response that redirects to the URL that was requested is never stored.

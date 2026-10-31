# ADR 0015 — Owner audit tokens let Hypdriv's own tooling through its bot shield

**Status:** accepted · **Date:** 2026-10-30

## Context

`hypdriv audit css` drives headless Chrome, whose user agent contains `HeadlessChrome`; the default bot policy blocks it with 403. The audit then evaluated the 403 body, found zero author rules and reported "0 overrides" — a vacuous pass. `audit`, `bench` and `warm` also trip rate limits and are logged as automated traffic. Allow-listing user agents would let anyone spoof them.

## Decision

- **Token.** `signAuditToken(secret, { host, ttlSeconds })` mints `v1.<exp>.<HMAC(secret, "audit:v1:<exp>:<host>")>` with the internal secret (`security.internalAuth.secretEnv`). Lifetime defaults to 30 minutes and verifiers refuse tokens claiming more than one hour. The token is bound to the audited host name.
- **Transport.** The CLI sends it as `x-hypdriv-audit` (a trusted inbound header, so the sanitiser keeps it). Headless Chrome adds it through DevTools `Fetch` interception scoped to the audited origins, so third-party requests never see it.
- **Effect.** `verifiedAudit()` (memoised per request) makes the `bots` stage classify the request as `human` (`reason: audit-token`) and the `rate-limit` stage skip it. Nothing else changes: CSP, caching, headers and rendering are exactly what visitors get. The host is checked against the URL host and the `Host` header, because some servers rewrite the URL host (`next start` reports `localhost`).
- **Honest results.** The Purser audit fails pages answered with an HTTP error status and pages where no author rule could be evaluated, instead of passing them. `--anonymous` audits without the token.

## Consequences

- Audits, benchmarks and warm-ups work against production configurations with strict bot policies, locally and on deployments, without weakening the shield for anyone else.
- A leaked token is useless after its expiry and on other hosts, and grants only bot-shield and rate-limit bypass.
- Applications that rotate `HYPDRIV_INTERNAL_SECRET` invalidate outstanding tokens immediately.

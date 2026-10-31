---
"@hypdriv/core": minor
"@hypdriv/security": minor
"@hypdriv/purser": minor
"@hypdriv/cli": minor
---

Owner audit tokens: Hypdriv's own tooling passes its bot shield and rate limits.

- `@hypdriv/security`: `signAuditToken` / `verifyAuditToken` (host-bound HMAC with the internal secret, at most one hour) and `verifiedAudit()`; the `bots` stage classifies verified audits as `human` (`audit-token`) and the `rate-limit` stage skips them. The URL host and the `Host` header are both accepted, for servers that rewrite the URL host.
- `@hypdriv/core`: `x-hypdriv-audit` is a trusted inbound header (`HEADER.auditToken`).
- `@hypdriv/purser`: the zero-override audit adds extra headers through DevTools `Fetch` interception scoped to the audited origins, fails pages answered with an HTTP error status, and fails pages where no author rule could be evaluated instead of reporting a vacuous pass.
- `@hypdriv/cli`: `audit`, `bench` and `warm` sign their requests with a token from `HYPDRIV_INTERNAL_SECRET` (environment, `.dev.vars`, `.env.local`) and send Vercel's `x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is set; `--anonymous` audits as a stranger. Shield answers (403 with `x-hypdriv-bot`, 429) fail with a hint instead of being graded.

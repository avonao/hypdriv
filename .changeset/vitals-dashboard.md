---
"@hypdriv/observe": minor
"@hypdriv/security": minor
"@hypdriv/runtime": minor
"@hypdriv/core": minor
"@hypdriv/cli": minor
---

Vitals dashboard: `observe.vitals.dashboard` serves `/_hypdriv/dash`, a script-free, token-protected page with site-wide p75 per metric, the good / needs-improvement / poor split, trends and a per-route table. It reads Workers Analytics Engine through its SQL API (`HYPDRIV_ANALYTICS_ACCOUNT_ID`, `HYPDRIV_ANALYTICS_API_TOKEN`, dataset) and falls back to a bounded in-memory buffer of what one instance receives, labelled as partial data. Access is `HYPDRIV_DASH_TOKEN` (24+ characters) exchanged once for a signed, host-bound `HttpOnly` session cookie, or a bearer header for `?format=json`; without it the route answers 404. `@hypdriv/observe` exports the SQL builders, `queryAnalyticsEngine`, `analyticsEngineVitalsSource`, `memoryVitals`, `cachedVitalsSource` and `renderVitalsDashboard`; `@hypdriv/security` exports the session helpers. `hypdriv vitals --trend` prints p75 over time and `hypdriv doctor` checks the token, secrets and sink.

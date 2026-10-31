---
"@hypdriv/next": patch
"@hypdriv/cloudflare": patch
"@hypdriv/cli": minor
---

Private deployments:

- **`forceHttps` covers every response.** `httpsUpgrade()` (from `@hypdriv/next/stages`) answers a plain-HTTP request with `308` before anything else, so the Worker no longer serves `/_hypdriv/*` (health, vitals, CSP reports, live channels) or static assets over HTTP; `proxy.ts` applies it before its internal routes too. OpenNext's revalidation requests are exempt. `forcesHttps(config)` exposes the resolved setting.
- **Gateway access for the CLI.** `hypdriv audit`, `bench`, `warm` and `jobs run` pass a gateway in front of the deployment: Vercel Deployment Protection (`VERCEL_AUTOMATION_BYPASS_SECRET`, now also for `jobs run`), Cloudflare Access service tokens (`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`), and any other gate through `HYPDRIV_ACCESS_HEADERS` (`name: value` lines or a JSON object) or `--header 'name: value'` (repeatable). Headers go to the audited origin only (also from the CSS audit's Chrome) and are never logged.

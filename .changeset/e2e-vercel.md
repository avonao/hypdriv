---
"@hypdriv/vercel": patch
"@hypdriv/next": patch
"@hypdriv/flags": patch
"@hypdriv/live": patch
"@hypdriv/devtools": patch
"hypdriv": patch
---

`e2e/vercel`: a live suite for Vercel (41 checks on the Hobby plan, read through the runtime-logs stream, with a provisioning script for any team), the Vercel counterpart of `e2e/cloudflare`. The guide documents what it established: purges from functions, per-country CDN entries for Route Handlers, the route-header limits of pages, Vercel Cron on Hobby (`vercel crons run`), Vercel Queues retries without a dead-letter queue, Global Config read tokens and propagation, WAF rate-limit rules through `@vercel/firewall`, BotID, environment variables bound per deployment. `vercel.botId` is documented as the default check level of `botIdGuard()`. Client entries keep their `'use client'` boundary through an enforcing build plugin (the package build is warning-free).

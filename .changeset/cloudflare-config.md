---
"@hypdriv/cli": minor
---

`hypdriv doctor` and `hypdriv init` read the `cf` CLI's `cloudflare.config.ts` when a project has no Wrangler file: the file is evaluated in an isolated child Node process with a stand-in for `cf/config` (the Worker entry never runs) and mapped to the settings the Wrangler checks inspect (entry, compatibility date and flags, observability, assets, KV, R2, D1, queues, services, Durable Objects and their classes, Analytics Engine, cron triggers). `--env <name>` selects the config's `mode`. The file is never edited: `init` prints only the settings it lacks. Needs Node 22.18 or later, like the `cf` CLI.

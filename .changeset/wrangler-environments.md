---
"@hypdriv/cli": patch
---

Wrangler environments: `hypdriv doctor --env <name>` (or `HYPDRIV_WRANGLER_ENV`) checks `env.<name>` the way Wrangler resolves it (bindings such as KV, R2, Durable Objects, service bindings, Analytics Engine and Rate Limiting are not inherited from the top level), and the new `wrangler.env-bindings` check warns when an environment lacks binding kinds the top level declares: such an environment deploys cleanly and then runs without the capability. `hypdriv analyze` now measures the Wrangler config selected with `--wrangler` / `--env` instead of always the default one. `hypdriv init` appends `.dev.vars`, `.hypdriv/` and `*.hypdriv.bak` to `.gitignore`, and the `.dev.vars.example` placeholders are long enough not to trip `security.secret-strength` when copied verbatim.

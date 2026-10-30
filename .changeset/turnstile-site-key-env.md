---
"@hypdriv/core": minor
"@hypdriv/security": minor
---

`security.bots.turnstile.siteKeyEnv` reads the Turnstile site key from the environment (default `TURNSTILE_SITE_KEY` when no literal `siteKey` is configured), so environments — and Cloudflare's always-pass test keys — switch with a secret change instead of a code change. The challenge page answers `challenge-unavailable` when neither is set.

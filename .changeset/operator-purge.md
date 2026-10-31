---
"@hypdriv/core": patch
"@hypdriv/security": patch
"@hypdriv/runtime": patch
"@hypdriv/cloudflare": patch
"@hypdriv/cli": patch
---

`hypdriv purge --url <base> (--tag … | --path … | --all)` and the signed internal route `POST /_hypdriv/purge`: the operator's purge for a running deployment. A raw Cloudflare tag purge removes only the Cache API copies, while HypDriv keeps entries in memory and in KV (days), so the purge has to run inside the Worker. The route accepts only a short-lived `x-hypdriv-purge` token (new `signPurgeToken` / `verifyPurgeToken` in `@hypdriv/security`, bound to the host, signed with `HYPDRIV_INTERNAL_SECRET`, its own payload prefix so an audit token never purges, five minutes at most) and answers `404` as if absent otherwise; `409` when the application has no edge cache. The runners strip client-supplied `x-hypdriv-*` headers, so the route receives the token from the original request.

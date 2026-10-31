---
"@hypdriv/core": patch
"@hypdriv/cache": patch
"@hypdriv/security": patch
"@hypdriv/cli": patch
---

Edge cache: `/legal` and `/legal/` are different cache entries. The key used to normalise the trailing slash to the Next `trailingSlash` setting, so with `trailingSlash: true` the redirect `/legal` → `/legal/` and the page shared one entry: whichever was requested first on an empty cache was served for the other, and `/legal/` answered `308 → /legal/` in a loop (the default cacheable statuses include 301 and 308). The key now keeps the slash as requested, a redirect to the URL that was requested is never stored (`uncacheable:self-redirect`), and `purgeUrls` clears both forms of a page. Cache key format `hypdriv-key/2` (existing entries miss once).

Hash CSP: the runtime now uses the hashes of the document that was requested. The build hashes every `generateStaticParams` page under `<route id>#<pathname>` but the stage only read the route-level entry (the first page), so every other page of such a route had a hash that did not match its inline scripts (Next's flight data above all) and the browser blocked them; the runtime-rendered `not-found` page of such a route failed with React error 412. A route with per-path entries now gets the matching entry, and a path without one (a page beyond the hashed limit, a not-found page) gets a nonce.

`hypdriv audit` and `hypdriv bench` choose paths with the trailing slash when the app uses `trailingSlash: true` (they audited the 308 redirects). `hypdriv init` no longer adds a script whose command the project already has under another name (`cf:typegen` vs `cf-typegen`), notes when an existing `.dev.vars.example` lacks the HypDriv secrets, and reminds to review and delete the `*.hypdriv.bak` backups. `hypdriv doctor` no longer warns about a missing tag cache, queue or `WORKER_SELF_REFERENCE` on sites whose sources never call `revalidateTag`, `revalidatePath`, `'use cache'` or fetch tags and that have no ISR routes.

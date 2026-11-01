---
"@hypdriv/core": minor
"@hypdriv/cache": minor
"@hypdriv/cloudflare": minor
"@hypdriv/observe": minor
"@hypdriv/cli": minor
---

Smart warming. `cache.warm.hot` learns the busiest pages from the Web Vitals in Workers Analytics Engine (one `TTFB` per navigation, counted per pathname) and warms them next to `cache.warm.routes` on every `cache.warm.cron` run: the Worker queries the SQL API with `HYPDRIV_ANALYTICS_ACCOUNT_ID` / `HYPDRIV_ANALYTICS_API_TOKEN` and warms the top `limit` pages of the last `days` days. Pathnames come from a public beacon, so they must be plain absolute paths of the site, need `minViews` measured views and must be pages the edge cache would keep (`createCacheableTest` in `@hypdriv/cache`); a failing query or a missing secret still warms the configured routes. `hypdriv warm --hot [--days] [--limit] [--min-views] [--dataset] [--sql]` does the same from a terminal or CI, and `hypdriv doctor` checks the sink, the secrets and the schedule (`security.warm-hot`). `@hypdriv/observe` exports `hotPathsSql`, `hotPaths` and `sanitizeHotPath`.

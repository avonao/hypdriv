---
'@hypdriv/cli': minor
---

Implement the `hypdriv` CLI: `init` (plan/apply with backups, idempotent edits of next.config, wrangler.jsonc, tsconfig, package.json; Vercel target writes `vercel.json#crons`), `doctor` (90+ platform-tagged checks with safe `--fix`), `analyze` (Worker bundle attribution via source-map VLQ decoding and the OpenNext metafile; Vercel function bundles from `.vercel/output`), `routes`, `audit headers|csp|cache|css|all`, `budget` (snapshots, diffs, Markdown), `csp hashes|suggest|print`, `css build|check|watch`, `warm`, `bench`, `deps` (workspace freshness with catalog-aware safe updates), `manifest`, `jobs`, `vitals` and `agent`. Every command supports `--json`, `--root` and `--platform`, and takes an injectable IO for programmatic use (`main`, `runCommand`).

---
"@hypdriv/runtime": patch
"@hypdriv/security": patch
"@hypdriv/core": patch
"@hypdriv/cli": patch
---

Webpack builds of Next.js apps (`next build --webpack`, the OpenNext setup of multi-area fleets): the runtime's lazy `node:fs/promises` / `node:path` imports carry `webpackIgnore` so the instrumentation chain no longer fails with `UnhandledSchemeError`; `NEXT_DEPLOYMENT_ID` and `__HYPDRIV_BUILD_DEPLOYMENT_ID` are public by design and no longer trip the secrets scan of client assets. `hypdriv.config.ts` is loaded by Node's ES module loader: an extensionless relative import now fails with the file to write (`'./shared.ts'`) instead of "install the dependencies first". `hypdriv doctor` (`opennext.cache`) fails when routes use a hash CSP and no incremental cache serves their prerendered HTML: without one OpenNext renders them per request, the inline-script hashes stop matching and the page never hydrates.

The CLI accepts `--wrangler <file>` (or `HYPDRIV_WRANGLER_CONFIG`) on every command: `hypdriv doctor` can check a generated Wrangler config that lives outside the project, such as the per-Worker `infra/<name>.wrangler.jsonc` files of a multi-Worker build. `main` and `assets.directory` resolve against that file as Wrangler resolves them, so the `wrangler.assets` check no longer warns for a config in another directory.

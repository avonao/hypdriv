---
"@hypdriv/waku": minor
"@hypdriv/core": minor
"@hypdriv/cli": minor
"create-hypdriv": minor
---

New package: Hypdriv for Waku (1.0 release candidates, React Server Components on Vite) on Cloudflare Workers, Vercel and Node. `withHypDriv()` in `waku.config.ts` selects the Hypdriv adapter of the build's target (`@hypdriv/waku/adapters/node|vercel|cloudflare`, which wrap Waku's own adapters and run the Drivetrain around every request) and adds the Vite plugin that writes the route manifest from `src/pages` and `createPage` / `createApi` calls, the CSP hashes of prerendered pages, the static headers, the Vercel clean-URL overrides and Routing Middleware, and the final manifest in every server output. Waku's managed mode needs no file; a project's own `src/waku.server.tsx` imports the adapter instead. On Cloudflare the Worker is Hypdriv's shell around Waku's adapter with the Durable Object classes exported from the entry (`@hypdriv/waku/durable-objects`) and a virtual entry for `waku dev` in managed mode. `@hypdriv/waku/server` provides `hyp()`, `nonce()`, `flag()`, `geo()`, `defer()` and `jobHandler()` for server components, server functions and `_api` routes. `hypdriv init` wraps `waku.config.ts` (and adds the Cloudflare plugin and wrangler settings), `hypdriv doctor` gets the `waku.adapter`, `waku.cloudflare-plugin`, `waku.worker-main` and `waku.version` checks, `create-hypdriv --framework waku` scaffolds `examples/waku` for any platform, and `@hypdriv/core`'s `FrameworkName` gains `waku`.

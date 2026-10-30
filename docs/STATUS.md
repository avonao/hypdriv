# HypDriv — build status and handoff

_Frozen 2026-10-30 (end of day 1). Read this first when resuming; it lists exactly what is done, what is half-done and what is next._

## Done and verified (typecheck + tests green, run against `src` via the `source` condition)

| Package | Tests | Notes |
| --- | --- | --- |
| `@hypdriv/core` | 87 | `StageErrorResolution` (`'continue'`), `importConfigModule` (TS configs, strip-types fallback), `ID_FIELD_KEYS` exemption in `redactFields`, `sanitizeInboundRequest`, `PurserManifest.asset` |
| `@hypdriv/cache` | 75 + 4 workerd | edge cache engine (`UPSTREAM_KEY` contract wired in both runners) |
| `@hypdriv/observe` | 43 | tracing, logging, Server-Timing, vitals |
| `@hypdriv/security` | 148 | CSP (extra hashes + Purser theme hash now allowed in nonce mode too), headers, rate limiting, bots, shield (Host fallback), actions, crypto |
| `@hypdriv/purser` | 69 | bridge, verify guard, themes, audit (CDP) |
| `@hypdriv/flags` / `live` / `image` / `devtools` / `testing` | 53 / 25+7 / 18 / 23 / 25+2 | image loader now reads build-time `env.HYPDRIV_IMAGES` |
| `@hypdriv/next` | 65 | adapter, `withHypDriv`, proxy (passes through inside the Worker, strips spoofable headers), server helpers (`ThemeScript` added; `devtoolsMeta` hides `serverOnly` flags), instrumentation |
| `@hypdriv/cloudflare` | 26 + 7 workerd | Worker shell, DOs, handlers. **Fixed a real bug**: DO RPC was invoked via `.apply` (sent as an RPC name) → rate limiting silently failed open; now called as a method and store errors are logged |
| `hypdriv` (umbrella) | 2 | subpaths: config, proxy, cloudflare, durable-objects, server, client, cache, instrumentation, next, security, flags, live, observe, image, purser; `bin/hypdriv.js` → `main()` from `@hypdriv/cli` |

All vitest configs now carry `ssr: { resolve: { conditions: ['source'] } }` (before this, tests silently ran against stale `dist/`).

## In progress when frozen

1. **`@hypdriv/cli`** (agent stopped mid-work): 49 source files exist (`args`, `ui`, `project`, `doctor/`, `analyze/`, `audit/`, `deps/`, `init/`, `templates/`, commands `init/doctor/analyze/audit/budget/routes`). Still to write: `csp`, `css`, `warm`, `bench`, `deps`, `manifest`, `jobs`, `vitals`, `agent` commands, `src/index.ts` exporting `main(argv, io?) → Promise<number>` (must not call `process.exit`), `src/bin.ts`, tests, README. Spec: `docs/guides/cli.md` and `docs/contracts.md#hypdriv-cli`. Requirements added during the day (must be honoured):
   - templates import from umbrella subpaths (`hypdriv/config`, `hypdriv/proxy`, …) — mirror `examples/basic` exactly;
   - `proxy.ts` must export a **literal** `export const config = { matcher: [...] }` (Next rejects `export { matcher as config }`); add a doctor check for it;
   - `instrumentation.ts` passes `{ config }`; `tsconfig.json` must exclude `hypdriv.worker.ts`;
   - audit/warm/bench send a realistic desktop User-Agent + `accept-language` (the bots stage 403s UA-less navigations).
2. **`examples/with-purser`** — written (tokens, styles, components, layout with `ThemeScript`, docs route). Purser compiles it (74 classes). `next build` currently fails at prerender of `/`: `HypDrivMeta` and `Speculation` in `<head>` call `headers()`, which Cache Components forbids outside `<Suspense>`. **Next step**: make `HypDrivMeta`/`Speculation` prerender-safe (no request APIs in the static shell — e.g. render inside a Suspense boundary in `<body>` or move the meta data to the HUD's dev endpoint) and make `ThemeScript` render without a nonce (its hash is now allowed by the CSP stage on every route). Then rebuild packages (`pnpm -r --filter "./packages/*" build`) and rerun `next build` in both examples.
   - Local Purser for testing: copy `/Users/apple.m5.pro/Workspace/purser` (`package.json src types bin scripts`) into `examples/with-purser/node_modules/@avonao/purser` (a symlink outside the project root breaks Turbopack). `@avonao/purser` is an `optionalDependency` so `pnpm install` works while it is unpublished.
3. Edge-runtime warnings during `next build` (instrumentation is also compiled for Edge): `process.versions` and `node:crypto` in `@hypdriv/security` passwords — harmless but should be silenced (guard with `typeof EdgeRuntime` or split the passwords module out of the root entry).

## Next (in order)

1. Finish items 1–3 above.
2. `create-hypdriv` (templates synced from `examples/*` at build time: resolve `catalog:`/`workspace:*` to real versions, `_gitignore`, `--pm`, `--purser`, `--no-install`, `--no-git`, tests).
3. End-to-end on both examples: `next build` → `opennextjs-cloudflare build` → `wrangler dev` → `hypdriv audit all` and `audit css`. OpenNext bundles `proxy.ts` as experimental Node middleware — verify it passes through inside the Worker.
4. `docs/feature-catalog.md`: replace the blanket ✅ with real statuses; changesets for every package; root CHANGELOG.
5. Full gate: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`, then commit and push.

## Where things live

- Cloud working copy: `/home/claude/hypdriv` (ephemeral container). The Mac copy at `/Users/apple.m5.pro/Workspace/HypDriv/repo` is the durable one — synced at freeze time.
- Purser (read-only, never edited): `/Users/apple.m5.pro/Workspace/purser`.

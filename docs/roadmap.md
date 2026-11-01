# Roadmap

Hypdriv ships complete capabilities; this roadmap lists the next complete capabilities, not partial steps toward the current ones.

## 0.1 — initial public release

Everything in `docs/feature-catalog.md` marked ✅ or 🧪, validated end to end by the example apps on `@opennextjs/cloudflare` 1.20+ with Next.js 16.4.

## 0.2

- **OpenNext adapter integration**: when OpenNext's Adapter-API-based Cloudflare adapter ships, make it the default base adapter and read its output map (Worker entry, assets directory) instead of assuming `.open-next/`.
- **`cloudflare.config.ts` support**: `hypdriv init` and `doctor` understand the `cf` CLI's TypeScript configuration in addition to `wrangler.jsonc`.
- **Vitals dashboard page**: `/_hypdriv/dash` (token protected) rendering p75 trends from Analytics Engine without the CLI.

## 0.3

- **Edge A/B experiments** on top of flags: assignment persistence, exposure events to the vitals sink, and a `hypdriv experiments` report.
- **Smart warming**: learn hot routes from vitals/Analytics Engine data and warm them on a schedule.
- **Image placeholders without sharp**: a pure-WASM decoder path for CI environments without native modules.

## 1.0

- Stability guarantees for the config schema (`defineConfig`) and the manifest schema (`version: 1`), semver commitments, and a verified compatibility matrix across Next 16.x and 17.
- Next.js 17 support when released (Cache Components default), including the removal of any 16-only code paths behind version detection.

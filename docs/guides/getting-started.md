# Getting started

## New project

```sh
npm create hypdriv@latest my-app -- --pm pnpm
cd my-app
pnpm dev          # next dev (proxy.ts runs the HypDriv stages)
pnpm preview      # opennextjs-cloudflare build && opennextjs-cloudflare preview (the Worker shell)
pnpm deploy       # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

Add `--purser` to scaffold the Purser CSS integration as well.

## Existing project on OpenNext Cloudflare

```sh
pnpm add hypdriv
npx hypdriv init
```

`hypdriv init` detects Next.js (16+), `@opennextjs/cloudflare`, wrangler configuration, Purser and TypeScript, then:

1. writes `hypdriv.config.ts` with commented defaults,
2. wraps `next.config.ts` in `withHypDriv()` — your options are preserved,
3. writes `hypdriv.worker.ts` and points `wrangler.jsonc#main` at it (OpenNext's Durable Object exports stay available),
4. writes `proxy.ts` with `createProxy()` unless you already have one (then it prints how to compose),
5. writes `public/_headers` for immutable `/_next/static` assets,
6. adds `hypdriv:doctor`, `hypdriv:analyze` and `hypdriv:audit` scripts,
7. runs `hypdriv doctor` and prints what else to do (secrets to set, optional bindings).

Every file it touches is backed up as `<name>.hypdriv.bak` first. Run it again at any time; it is idempotent.

## Existing project that is not on Cloudflare yet

Run `npx @opennextjs/cloudflare migrate` first (it configures OpenNext), then `npx hypdriv init`. Alternatively use HypDriv without Cloudflare: `withHypDriv()` and `createProxy()` work on `next start` and on other hosts; the Worker-only capabilities (edge cache, nonce injection for cached HTML, live channels, scheduled handlers) are simply reported as unavailable by `hypdriv doctor`.

## Verify

```sh
pnpm build                      # next build → .hypdriv/manifest.json and report.md
npx hypdriv routes              # classification, cache policy and CSP mode per route
npx hypdriv analyze             # Worker weight (needs opennextjs-cloudflare build), per-route assets, budgets
pnpm preview &
npx hypdriv audit all --url http://localhost:8787
```

Open the site in development and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> for the DevTools HUD (render `<HypDrivDevTools />` from `@hypdriv/next/client` in your root layout; `hypdriv init` does that for you).

## Secrets

| Variable | Used by | Required |
| --- | --- | --- |
| `HYPDRIV_SESSION_SECRET` | encrypted sessions, CSRF tokens | when you use sessions/CSRF |
| `HYPDRIV_INTERNAL_SECRET` | signed cron/queue → Route Handler requests | when you use jobs |
| `CACHE_PURGE_ZONE_ID`, `CACHE_PURGE_API_TOKEN` | zone-level purge on `revalidateTag` | optional |
| `TURNSTILE_SECRET_KEY` | bot challenges | optional |
| `OTLP_HEADERS` (or the name you configure) | OTLP exporter authentication | optional |

Set them with `wrangler secret put <NAME>` for production and in `.dev.vars` for `wrangler dev`.

## Next steps

- [Configuration reference](configuration.md)
- [Cloudflare bindings and what each unlocks](cloudflare.md)
- [Caching](caching.md) · [Security](security.md) · [Observability](observability.md) · [Purser CSS](purser.md)

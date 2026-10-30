# Getting started

## New project

```sh
npm create hypdriv@latest my-app -- --pm pnpm
cd my-app
pnpm dev          # next dev (proxy.ts runs the HypDriv stages)
pnpm preview      # opennextjs-cloudflare build && opennextjs-cloudflare preview (the Worker shell)
pnpm deploy       # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

Add `--purser` to scaffold the Purser CSS integration as well. For Vercel:

```sh
npm create hypdriv@latest my-app -- --platform vercel --pm pnpm
cd my-app
pnpm dev          # next dev (proxy.ts runs the HypDriv stages)
pnpm build        # next build (withHypDriv emits the Vercel CDN route headers)
vercel deploy
```

The scaffolder generates local secrets (`.dev.vars` on Cloudflare, `.env.local` on Vercel), names the Worker and its resources after the project, and initialises git. See [`create-hypdriv`](../../packages/create-hypdriv/README.md) for every option.

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

## Existing project on Vercel

```sh
pnpm add hypdriv
npx hypdriv init --platform vercel
```

The same steps without the Worker entry: `proxy.ts` runs the stages in Routing Middleware and wires the Vercel CDN, Upstash / Global Config stores and Vercel purges automatically; `vercel.json#crons` is kept in sync with `jobs.cron`. See the [Vercel guide](vercel.md).

## Existing project on another host

To move to Cloudflare, run `npx @opennextjs/cloudflare migrate` first (it configures OpenNext), then `npx hypdriv init`. HypDriv also runs on any Node host (`next start`, containers): `withHypDriv()` and `createProxy()` work there, and the Worker-only capabilities (edge cache storage, nonce injection for cached HTML, live channels over Durable Objects, scheduled handlers) are reported as unavailable by `hypdriv doctor --platform node`.

## Verify

```sh
pnpm build                      # next build → .hypdriv/manifest.json and report.md
npx hypdriv routes              # classification, cache policy and CSP mode per route
npx hypdriv analyze             # Worker weight (needs opennextjs-cloudflare build), per-route assets, budgets
pnpm preview &
npx hypdriv audit all --url http://localhost:8787
```

Open the site in development and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> for the DevTools HUD (render `<HypDrivDevTools />` from `hypdriv/client` in your root layout; `hypdriv init` does that for you).

## Secrets

| Variable | Used by | Required |
| --- | --- | --- |
| `HYPDRIV_SESSION_SECRET` | encrypted sessions, CSRF tokens | when you use sessions/CSRF |
| `HYPDRIV_INTERNAL_SECRET` | signed cron/queue → Route Handler requests, `hypdriv jobs run`, audit tokens | when you use jobs |
| `CRON_SECRET` | Vercel Cron → job routes | on Vercel with crons |
| `CACHE_PURGE_ZONE_ID`, `CACHE_PURGE_API_TOKEN` | zone-level purge on `revalidateTag` | optional |
| `TURNSTILE_SECRET_KEY` | bot challenges | optional |
| `OTLP_HEADERS` (or the name you configure) | OTLP exporter authentication | optional |

Set them with `wrangler secret put <NAME>` for production and in `.dev.vars` for `wrangler dev` on Cloudflare; with `vercel env add <NAME>` and in `.env.local` on Vercel.

## Next steps

- [Configuration reference](configuration.md)
- [Cloudflare bindings and what each unlocks](cloudflare.md) · [Vercel services and what each unlocks](vercel.md)
- [Caching](caching.md) · [Security](security.md) · [Observability](observability.md) · [Purser CSS](purser.md)

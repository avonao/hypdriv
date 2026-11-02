# Hypdriv × Analog

Prerendered `/` and `/about` (`prerender.routes`), server-rendered `/ssr` (request facts through `injectHyp()` and Angular's transfer state) and `/blog/[slug]`, and the Nitro routes `GET /api/hello` and `POST /api/echo`. One app, three deploy targets: Cloudflare Workers, Vercel and Node. The Hypdriv configuration is `hypdriv.config.ts`; the integration is described in the [Analog guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/analog.md).

Analog 2.9 on Angular 22 (zoneless) and Nitro 2.

## Run it

```sh
pnpm install
pnpm dev                                        # Vite dev server; the API routes run behind the Hypdriv pipeline
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `pnpm preview:cloudflare` | `pnpm deploy:cloudflare` |
| Vercel | `pnpm build:vercel` (on Vercel `VERCEL=1` selects it) | `vercel build` (Build Output API in `.vercel/output`) | `vercel deploy --prebuilt` or a Git deployment |
| Node | `pnpm build:node` | `pnpm start` (port 3000) | any Node 22+ host |

The target comes from `HYPDRIV_TARGET` (`cloudflare` by default, `vercel` when `VERCEL=1`). On Cloudflare, an account-specific wrangler configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc` and selected with `WRANGLER_CONFIG`.

## What to look at

- `vite.config.ts`: `analog(withHypDriv({ … }))` adds the Hypdriv Nitro module; `hypdriv()` is the Vite plugin (client build manifest, `/_hypdriv/*` in `vite dev`).
- `src/app/app.config.server.ts`: `provideHypDriv()` makes Angular stamp the request's CSP nonce on what it renders and puts the nonce on the root element for the browser side.
- `src/app/request-facts.ts`: reads the request context on the server with `injectHyp()` and hands it to the browser with `TransferState`, so hydration finds the markup it expects.
- `src/server/routes/api/*`: Nitro routes reading the context with `hyp()` from `@hypdriv/analog/server`.

## Check it

```sh
pnpm hypdriv doctor                             # integration, registration, platform files
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:3000
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework analog --static / --static /about --dynamic /ssr --dynamic /blog/hello --api /api/hello --rate-limit 60
```

# Hypdriv × Nitro 3 (Vite)

A Nitro 3 server on Vite (`nitro/vite`): prerendered `/` and `/about` (route rules), a server-rendered `/ssr` with `hyp()`, content-hashed assets under `/assets/`, and the routes `GET /api/hello` and `POST /api/echo`. One app, three deploy targets: Cloudflare Workers, Vercel and Node. The Hypdriv configuration is `hypdriv.config.ts`; the integration is described in the [Nitro guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/nitro.md).

For Nitro 2 (`nitropack`) see [`examples/nitro`](../nitro).

## Run it

```sh
pnpm install
pnpm dev                                        # Vite development server with the Hypdriv pipeline
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `pnpm preview:cloudflare` | `pnpm deploy:cloudflare` |
| Vercel | `pnpm build:vercel` (on Vercel `VERCEL=1` selects it) | `vercel build` (Build Output API in `.vercel/output`) | `vercel deploy --prebuilt` or a Git deployment |
| Node | `pnpm build:node` | `pnpm start` (port 3000) | any Node 22+ host |

The target comes from `HYPDRIV_TARGET` (`cloudflare` by default, `vercel` when `VERCEL=1`). On Cloudflare, an account-specific wrangler configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc` and selected with `WRANGLER_CONFIG`.

## What to look at

- `vite.config.ts`: `nitro({ … })` configures the server (preset per target, route rules that prerender `/` and `/about`, public assets); `hypdriv()` from `@hypdriv/nitro/vite` is the only Hypdriv line. `vite dev` with the Cloudflare preset runs the Worker in miniflare with the Durable Objects exported, so rate limits behave as in production.
- `server/utils/page.ts`: stamps the request's nonce on the inline style and script (`nonce()` is `undefined` while Nitro prerenders, where Hypdriv hashes the inline code instead).
- `server/api/*`, `server/routes/ssr.ts`: read the request context with `hyp()` and feature flags with `flag()` from `@hypdriv/nitro/server`.

## Check it

```sh
pnpm hypdriv doctor                             # integration, registration, platform files
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:3000
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework nitro --static / --static /about --dynamic /ssr --api /api/hello --rate-limit 60
```

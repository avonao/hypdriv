# HypDriv × Nuxt 4

Prerendered `/` and `/about` (route rules), a server-rendered `/ssr` with `useHyp()`, and the server routes `GET /api/hello` and `POST /api/echo`. One app, three deploy targets: Cloudflare Workers, Vercel and Node. The HypDriv configuration is `hypdriv.config.ts`; the integration is described in the [Nuxt 4 guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/nuxt.md).

## Run it

```sh
pnpm install
pnpm dev                                        # development server with the HypDriv pipeline
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `pnpm preview:cloudflare` | `pnpm deploy:cloudflare` |
| Vercel | `pnpm build:vercel` (on Vercel `VERCEL=1` selects it) | `vercel build` (Build Output API in `.vercel/output`) | `vercel deploy --prebuilt` or a Git deployment |
| Node | `pnpm build:node` | `pnpm start` (port 3000) | any Node 22+ host |

The target comes from `HYPDRIV_TARGET` (`cloudflare` by default, `vercel` when `VERCEL=1`). On Cloudflare, an account-specific wrangler configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc` and selected with `WRANGLER_CONFIG`.

## Check it

```sh
pnpm hypdriv doctor                             # integration, registration, platform files
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:3000
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework nuxt --static / --static /about --dynamic /ssr --api /api/hello --rate-limit 60
```

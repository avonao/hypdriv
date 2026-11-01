# Hypdriv × SolidStart

Prerendered `/` and `/about`, a per-request `/request` page (a server function reading `hyp()`), a dynamic `/posts/:slug` route, a `[...404]` catch-all, the API route `/api/time` and a cron job endpoint. One app, three deploy targets: Cloudflare Workers, Vercel and Node. The Hypdriv configuration is `hypdriv.config.ts`; the integration is described in the [SolidStart guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/solid-start.md).

## Run it

```sh
pnpm install
pnpm dev                                        # development server with the Hypdriv pipeline
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `wrangler dev -c dist/server/wrangler.json` | `pnpm deploy:cloudflare` |
| Vercel | `pnpm build:vercel` (on Vercel `VERCEL=1` selects it) | `vercel build` (Build Output API in `.vercel/output`) | `vercel deploy --prebuilt` or a Git deployment |
| Node | `pnpm build:node` | `pnpm start` (port 3000) | any Node 22+ host |

The target comes from `HYPDRIV_TARGET` (`cloudflare` by default, `vercel` when `VERCEL=1`). On Cloudflare, an account-specific wrangler configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc` and selected with `WRANGLER_CONFIG`; local secrets go in `.dev.vars` (see `.dev.vars.example`).

SolidStart prerenders only through Nitro, so `/` and `/about` are static files on Node and Vercel (hash-based CSP) and render per request on Cloudflare (nonce-based CSP).

## Check it

```sh
pnpm hypdriv doctor                             # integration, registration, platform files
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:3000
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework solid-start --static / --static /about --dynamic /request --dynamic /posts/hello --api /api/time --rate-limit 60
```

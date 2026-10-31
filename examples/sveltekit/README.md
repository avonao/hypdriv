# Hypdriv × SvelteKit 3

Prerendered `/`, `/about` and `/blog/[slug]` pages, a server-rendered `/ssr`, a form action on `/form` and the endpoint `/api/hello`; SvelteKit's own `csp` option is folded into Hypdriv's single policy. One app, three deploy targets: Cloudflare Workers, Vercel and Node. The Hypdriv configuration is `hypdriv.config.ts`; the integration is described in the [SvelteKit 3 guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/sveltekit.md).

## Run it

```sh
pnpm install
pnpm dev                                        # development server with the Hypdriv pipeline
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `pnpm start:cloudflare` | `pnpm deploy:cloudflare` |
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
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework sveltekit --static / --static /about --static /blog/hello-world --dynamic /ssr --dynamic /form --api /api/hello --rate-limit 60
```

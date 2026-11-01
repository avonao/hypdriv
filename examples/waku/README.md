# Hypdriv × Waku

Waku 1 (React Server Components on Vite): prerendered `/` and `/about`, a dynamic `/dynamic` page that renders `hyp()` facts, and the API route `/api/hello` (`src/pages/_api/api/hello.ts`). One app, three deploy targets: Cloudflare Workers, Vercel and Node. The Hypdriv configuration is `hypdriv.config.ts`; `waku.config.ts` wraps Waku's config in `withHypDriv()`. The integration is described in the [Waku guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/waku.md).

## Run it

```sh
pnpm install
pnpm dev                                        # development server with the Hypdriv pipeline (port 3000)
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `pnpm preview:cloudflare` (port 8787) | `pnpm deploy:cloudflare` |
| Vercel | `pnpm build:vercel` (on Vercel `VERCEL=1` selects it) | `vercel build` (Build Output API in `.vercel/output`) | `vercel deploy --prebuilt` or a Git deployment |
| Node | `pnpm build:node` | `pnpm start` (port 3000) | any Node 22.15+ host |

The target comes from `HYPDRIV_TARGET` (`node` by default, `vercel` when `VERCEL=1`). On Cloudflare, `waku.config.ts` adds `@cloudflare/vite-plugin` for Waku's `rsc` and `ssr` environments, and an account-specific wrangler configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc` and selected with `WRANGLER_CONFIG`.

## Check it

```sh
pnpm hypdriv doctor                             # integration, adapter, Cloudflare plugin, platform files
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:3000
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework waku --static / --static /about --dynamic /dynamic --api /api/hello --rate-limit 60
```

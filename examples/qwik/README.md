# Hypdriv × Qwik

Qwik v2 with Qwik Router (on Vite): prerendered `/`, `/about/` and `/blog/hello/`, `/blog/qwik/` (the `onStaticGenerate` paths of the dynamic route `/blog/[slug]/`), a `/dynamic/` page that renders per request and shows what `hyp()` knows, and the endpoint `/api/hello` (`src/routes/api/hello/index.ts`). One app, three deploy targets: Cloudflare Workers, Vercel and Node. The Hypdriv configuration is `hypdriv.config.ts`; `vite.config.ts` adds the `hypdriv()` plugin to Qwik's, and `adapters/<target>/vite.config.ts` selects the Hypdriv adapter of a target. The integration is described in the [Qwik guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/qwik.md).

## Run it

```sh
pnpm install
pnpm dev                                        # development server with the Hypdriv pipeline (port 5173)
```

| Target | Build | Run locally | Deploy |
| --- | --- | --- | --- |
| Cloudflare Workers | `pnpm build:cloudflare` | `pnpm preview:cloudflare` (port 8787) | `pnpm deploy:cloudflare` |
| Vercel | `pnpm build:vercel` (on Vercel `VERCEL=1` selects it) | `vercel build` (Build Output API in `.vercel/output`) | `vercel deploy --prebuilt` or a Git deployment |
| Node | `pnpm build:node` | `pnpm start` (port 3000) | any Node 20.19+ host |

`pnpm build` picks the target from `HYPDRIV_TARGET` (`node` by default, `vercel` when `VERCEL=1`, `cloudflare` on Workers Builds): the client build, then the server build with the target's adapter. `pnpm preview` builds for Node plus Qwik's preview server entry and starts `vite preview`; it serves the build through the pipeline, but Vite's static server answers the hashed files itself, so their immutable caching comes from `pnpm start`. An account-specific wrangler configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc`; Cloudflare secrets for local runs go in `.dev.vars` (see `.dev.vars.example`).

## Check it

```sh
pnpm hypdriv doctor                             # integration, adapters, entries, platform files
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:3000
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework qwik --static / --static /about/ --dynamic /dynamic/ --api /api/hello --rate-limit 60
```

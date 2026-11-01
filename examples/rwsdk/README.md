# Hypdriv × RedwoodSDK

RedwoodSDK 1 (React Server Components on Vite and Cloudflare Workers): a home page with a client component and an edge-evaluated feature flag, an about page, a dynamic `/products/:id` page that renders `hyp()` facts, and the API route `/api/ping` (rate limited by the `api` policy). One target: Cloudflare Workers, which is what RedwoodSDK itself targets. The Hypdriv configuration is `hypdriv.config.ts`; `src/worker.tsx` wraps the app in `withHypDriv()`. The integration is described in the [RedwoodSDK guide](https://github.com/avonao/hypdriv/blob/main/docs/guides/rwsdk.md).

## Run it

```sh
pnpm install
pnpm dev                                        # development server with the Hypdriv pipeline (port 5173)
pnpm build && pnpm preview                      # the production Worker in workerd (port 4173)
pnpm deploy:cloudflare                          # vite build && wrangler deploy
```

`vite.config.mts` declares `@cloudflare/vite-plugin` (Worker environment `worker`) next to `redwood()` and `hypdriv()` so the Worker has one Wrangler config. An account-specific configuration can be kept in a git-ignored `wrangler.<name>.local.jsonc` and selected with `WRANGLER_CONFIG`. The build writes the deployable Worker to `dist/worker` and the static files to `dist/client`.

## Check it

```sh
pnpm hypdriv doctor                             # integration, plugin order, Worker entry, Wrangler config
pnpm hypdriv routes                             # routes, classifications, CSP mode (after a build)
pnpm hypdriv audit all --url http://localhost:4173
```

The repository's live checker verifies a deployment of this app end to end (security headers, CSP coverage of every script, fresh nonces, immutable assets, bot shield, rate limiting, HTTPS):

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework redwood --dynamic / --dynamic /about --dynamic /products/42 --api /api/ping --rate-limit 60 --expect-runner worker
```

(`--framework redwood` matches the health route's framework label, "RedwoodSDK".) Under `vite preview` the bot-shield check reports a failure that is not one: the preview proxy marks every request `sec-fetch-mode: cors`, so a `curl` user agent no longer looks like a navigation. `wrangler dev` and deployments do not have that artifact.

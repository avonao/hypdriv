# Hypdriv — basic example

Next.js 16 (Cache Components on) deployed to Cloudflare Workers with OpenNext and Hypdriv.

```sh
pnpm install
pnpm dev                 # next dev with the proxy running Hypdriv stages
pnpm preview             # opennextjs-cloudflare build + wrangler dev (the Worker shell)
pnpm hypdriv:doctor      # environment and configuration checks
pnpm hypdriv:analyze     # worker weight and per-route assets
pnpm hypdriv:audit       # headers, CSP, cache and CSS audits against the preview
```

Copy `.dev.vars.example` to `.dev.vars` before `pnpm preview`. Bindings in `wrangler.jsonc` are optional upgrades; remove any you do not want to create.

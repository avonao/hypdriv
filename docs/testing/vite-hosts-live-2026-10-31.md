# Live test of the Vite hosts — 2026-10-31

HypDriv on seven Vite-based frameworks — plain Vite, React Router 8, TanStack Start, Astro 7, SvelteKit 3, Nuxt 4 and vinext — each deployed from its example app to **Cloudflare Workers** (a Cloudflare account) and **Vercel** (Hobby team), US-first: requests reached Cloudflare through IAD/CMH and Vercel functions run in `iad1`. Every resource is named `hypdriv-dev-<framework>`; Workers carry the `hypdriv-dev` tag, Vercel deployments the `tag=hypdriv-dev` meta. Account tokens were used from the operator's shell only and never reached a deployment.

**Every deployment is private.**

- **Cloudflare:** custom domains `hypdriv-dev-<framework>.example-zone.dev` with `workers.dev` and preview URLs off, provisioned by `pnpm -F @hypdriv/e2e-hosts provision cloudflare`. The zone keeps two rules for all private HypDriv hosts (the Free plan allows five custom rules): a WAF custom rule that blocks HTTPS requests without the gate header or cookie, and a Redirect Rule that sends plain HTTP to https before anything answers. Anonymous requests get `403` over HTTPS and `308 → https` over HTTP.
- **Vercel:** `ssoProtection: all` on every project, plus an automation bypass per project for tooling (`provision vercel`). Anonymous requests get Vercel's login redirect (`302`).

## What ran

| Framework | Cloudflare (Worker) | Vercel (prebuilt from the repository root) |
| --- | --- | --- |
| Vite (SPA) | `assetsWorker()` in front of Workers Static Assets, `run_worker_first` for navigations | Build Output written by `@hypdriv/vite`: static files, header routes, Routing Middleware, an `api/` function |
| React Router 8 | `reactRouterWorker()` (assets first) | Build Output written by HypDriv: one traced function per server bundle, Routing Middleware scoped to prerendered pages |
| TanStack Start | `createStartWorker()` (assets first), `run_worker_first` | Nitro `vercel` preset + header routes + prerender middleware |
| Astro 7 | Worker shell around `@astrojs/cloudflare`'s handler | `@astrojs/vercel` + header routes + prerender middleware |
| SvelteKit 3 | Worker shell around adapter-cloudflare, `run_worker_first` | adapter-vercel + header routes + prerender middleware |
| Nuxt 4 | HypDriv's Worker entry around Nitro `cloudflare-module`, `run_worker_first` | Nitro `vercel` preset + header routes + prerender middleware |
| vinext | `createVinextWorker()`, pages packaged by `staticAssetsAdapter()` | Nitro `vercel` preset, prerendered pages copied to the CDN + prerender middleware |

## Results

**Live checks (`pnpm -F @hypdriv/e2e-hosts check`), all green on all 14 deployments.** Each run covered:

- `/_hypdriv/health` reports the framework, runner and target;
- prerendered pages (security preset; hash CSP that allows every inline and external script on the page) and rendered pages (nonce CSP with a fresh nonce per request and a request id);
- immutable caching of a content-hashed asset;
- the bot shield (automation user agent → `403`);
- an API route answering JSON;
- the IP-keyed rate limit returning `429` with `Retry-After` within 58–60 back-to-back requests;
- plain HTTP → `308` https;
- the request stages on every prerendered page (`stages on prerendered pages`: a `curl` user agent gets `403` on each `--static` path).

**Prerendered pages run the request stages on both platforms.** A `curl` user agent on a prerendered page gets `403` from:

- the Worker shell on Cloudflare (`run_worker_first`; the page is still served as built with its hash CSP);
- HypDriv's Routing Middleware on Vercel, scoped to exactly the prerendered documents (`GET`/`HEAD`). On-demand routes run the pipeline once, in the function.

**`hypdriv audit all` (headers, CSP, cache, HTTPS) passed on all 14.** On every deployment:

- pages graded A+; JSON API routes graded A with no CSP required;
- every inline script was covered by the page's hash or nonce;
- prerendered documents were reported as served by the platform's static layer: Workers Static Assets, or Vercel CDN `HIT`;
- vinext's prerendered pages were edge-cached by HypDriv on Cloudflare, following vinext's own `s-maxage`;
- pages, `/_hypdriv/health` and a hashed asset all redirected from `http://` to https.

**Feature flags by country:** `newHero` (rule: country US) rendered `true` on Vercel and Cloudflare after the geo fix below.

**Unit and integration suites:** `pnpm build`, `pnpm test` (all workspace projects, Node and workerd), `pnpm typecheck` and `pnpm lint` passed on the final commit. Each integration also ships tests that build a real app.

**Final re-run on the committed code.** After the last commit every Worker was rebuilt and redeployed and re-verified: Cloudflare checks 9, 10, 11, 10, 12, 10 and 10 passed (Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext) with `hypdriv audit all` passing on each; Vercel checks 9, 10, 11, 10, 12, 10 and 10 passed in the same order with the audit passing on each; the Next.js suites passed unchanged on both platforms (Cloudflare 41 pass / 0 fail / 2 skipped, Vercel 39 pass / 0 fail / 2 skipped). Cloudflare's API throttled one Nuxt deploy (error 971, `Retry-After` 104 s); it succeeded after the wait.

## Defects found and fixed

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | high | Without `site.origin`, `redirects.forceHttps: 'auto'` was off: Cloudflare custom domains served pages over plain HTTP with an HSTS header. | `auto` is on for Cloudflare and Vercel deployments when no origin is set (their edge terminates TLS); an explicit origin still decides, Node keeps plain HTTP unless configured. |
| 2 | high | Workers Static Assets answer before the Worker, so content-hashed assets (and prerendered pages without `run_worker_first`) were reachable over plain HTTP on the private hosts. | The zone Redirect Rule for gated hosts. New `hypdriv audit https` probes pages, `/_hypdriv/health` and a hashed asset over `http://` anonymously, and names the zone setting when assets are served over HTTP. |
| 3 | high | Country rules of feature flags never matched on Vercel and Node: the flags stage read geo only from Cloudflare's `request.cf`. This affected Next.js on Vercel too. | The stage falls back to the platform's geo headers (`x-vercel-ip-*`, `cf-ipcountry`). |
| 4 | high | Prerendered pages on Vercel and on Cloudflare without the shell carried static headers only: no rate limit, bot shield or maintenance. | HypDriv's Routing Middleware scoped to prerendered documents on Vercel (`addVercelMiddleware()`, every integration). `run_worker_first` + assets-first Workers for TanStack Start and Nuxt on Cloudflare. |
| 5 | high | The bundled Vercel middleware resolved its runtime from the application, so framework apps without a direct `@hypdriv/vite` dependency failed to build. | The bundle resolves `@hypdriv/vite/vercel-middleware` from the package itself. |
| 6 | high | `@hypdriv/runtime`'s `import('cloudflare:workers')` was folded into a literal, which broke Node and Vercel bundles (Rolldown, Vercel's file tracer). | The specifier is computed at run time; a workerd test proves bindings still resolve. |
| 7 | high | srvx's lazy `Request` look-alikes (Nitro Node presets, `@vitejs/plugin-rsc`) made `new Request(input, init)` throw, so every page returned 500 on Node. | `withRequestHeaders()` in core unwraps or rebuilds them. |
| 8 | medium | Framework SSR documents carrying a per-request nonce had no `Cache-Control`. | The CSP stage sets `private, no-cache` when the application sets none. |
| 9 | medium | Early Hints and static `Link` headers announced ES modules as `preload; as=script`, which downloads them twice. | `modulepreload` for Vite builds. |
| 10 | medium | `_headers` from frameworks that cache their own hashed assets (vinext) joined with HypDriv's rule into `public, …, immutable, public, …, immutable`. | Static rules leave headers that existing rules set for the same path. |
| 11 | medium | Prerendered dynamic routes (`/blog/[slug]` with all paths prerendered) got an inferred edge-cache policy on top of the platform's cache, and the audit expected HITs. | `HypRoute.servedStatically` for routes the static layer serves, by classification. Neither the runtime nor the build infers a policy for them. |
| 12 | medium | The SPA fallback on Vercel answered unknown `/api/*` paths with the HTML shell. | The fallback excludes `/api/*`; zero-config `api/` functions deploy alongside the Build Output. |
| 13 | low | The cache audit expected `Vary: rsc` outside Next.js and flagged CDN-served prerendered pages. The CSP audit expected policies on JSON endpoints. | Framework-aware and endpoint-aware audits. |
| 14 | low | The live checker's rate-limit test sent sequential requests (token buckets refill) or concurrent ones (NAT pools rotate client addresses). | One keep-alive connection, back to back, up to three windows' worth. |
| 15 | low | Example issues found only live. | The Astro example had no hashed asset (`build.inlineStylesheets: 'never'`). Nuxt's `/about` answered `307 → /about/` (`html_handling: drop-trailing-slash`). Nitro concatenates wrangler arrays when merging account config, so only the deployment's own keys are merged. |

## Notes

- Requests from this environment leave through several client addresses (a NAT pool). The rate-limit check therefore keeps one keep-alive connection.
- One request right after a Worker deploy returned `403` (version rollout); repeated runs were green.
- The zone rules were consolidated during the run. The existing Next.js deployments (`basic`, `purser`, `e2e`) moved from their own gate rule into the shared one, and `e2e/cloudflare`'s provisioning now uses the same shared implementation (`e2e/hosts/scripts/zone-gate.ts`).

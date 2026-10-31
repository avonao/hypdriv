---
name: hypdriv
description: Adopt, configure and operate HypDriv (the Hyper-Extension for Next.js 16+ and the Vite frameworks — plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext — on Cloudflare Workers, Vercel and Node) in an application — install, wire the framework integration/proxy/worker entry, tune caching, CSP, rate limits, flags, jobs, Purser CSS and observability, and verify with the hypdriv CLI.
---

# HypDriv for coding agents

Use this skill when a Next.js 16+ project or a Vite-based app (plain Vite, React Router 8, TanStack Start, Astro 7, SvelteKit 3, Nuxt 4, vinext) should run with HypDriv on Cloudflare Workers, Vercel or Node, or when an existing HypDriv setup needs configuration, diagnosis or verification. The deploy target comes from `hypdriv.config.ts#platform` (`auto` detects it; Vite hosts also read `HYPDRIV_TARGET` at build time); pass `--platform cloudflare|vercel|node` to CLI commands to override.

## 1. Detect the situation

```sh
npx hypdriv doctor --json
```

The JSON report names the framework it detected (Next.js-only checks are skipped for Vite hosts, which get their own: integration registered, Worker entry, wrangler `main`/assets, Build Output) and tells you: Next.js version and config, whether `@opennextjs/cloudflare` is installed, whether `withHypDriv` wraps `next.config`, whether `hypdriv.worker.ts` is the Worker entry, wrangler compatibility (date/flags/bindings), deprecated features in use (`middleware.ts`, Edge runtime segments), Purser status, bundle sizes against limits, secrets exposure, and header posture. Each check has `id`, `status` (`pass|warn|fail|skip`), `message`, and `fix` (a shell command or a file edit description).

## 2. Install and wire (new projects)

```sh
npm create hypdriv@latest my-app -- --pm pnpm                    # Cloudflare Workers (OpenNext)
npm create hypdriv@latest my-app -- --pm pnpm --platform vercel  # Vercel
# add --purser for Purser CSS; or in an existing project:
pnpm add hypdriv && npx hypdriv init [--platform vercel]
```

`hypdriv init` is idempotent. It:
1. writes `hypdriv.config.ts` (`defineConfig({...})`) with commented defaults,
2. wraps `next.config.ts` in `withHypDriv()` (keeps existing options),
3. on Cloudflare: writes `hypdriv.worker.ts` and sets `wrangler.jsonc#main` to it (keeps OpenNext's Durable Object exports); on Vercel: syncs `vercel.json#crons` with `jobs.cron` and writes `.env.example`,
4. writes `proxy.ts` with `createProxy()` when none exists (on Vercel it wires `@hypdriv/vercel` automatically) and `instrumentation.ts` with `createInstrumentation()`,
5. adds scripts: `hypdriv:doctor`, `hypdriv:analyze`, `hypdriv:audit`,
6. optionally scaffolds the Purser bridge when `@avonao/purser` is installed.

For a Vite framework, `create-hypdriv` takes `--framework vite|react-router|tanstack-start|astro|sveltekit|nuxt|vinext` (`--platform cloudflare|vercel|node`), and `hypdriv init` in an existing app detects the framework and:
1. writes `hypdriv.config.ts` and adds the framework package (`@hypdriv/vite`, `@hypdriv/react-router`, `@hypdriv/tanstack-start`, `@hypdriv/astro`, `@hypdriv/sveltekit`, `@hypdriv/nuxt` or `@hypdriv/vinext`),
2. registers the integration in the framework's config (Vite plugin, React Router preset, Astro integration, SvelteKit adapter wrapper, Nuxt module) and wires the request hook the framework owns (root `middleware`, `src/start.ts`, `handle`, `proxy.ts`),
3. on Cloudflare: writes the Worker entry and wrangler `main`, the assets binding and `run_worker_first` patterns (prerendered pages run the request stages through the Worker shell and are still served as built), plus the Durable Object exports; on Vercel the integration writes the Build Output with HypDriv's Routing Middleware scoped to prerendered pages,
4. prints the install commands for the framework's own adapter when one is missing.

Per-framework guides: `docs/guides/{vite,react-router,tanstack-start,astro,sveltekit,nuxt,vinext}.md`.

Never hand-edit `.hypdriv/` — it is build output.

## Production on Cloudflare

For a deployment that goes live, follow `docs/guides/production-cloudflare.md` in the HypDriv repository (https://github.com/avonao/hypdriv/blob/main/docs/guides/production-cloudflare.md) instead of improvising: it lists the rules that break production (populate the OpenNext R2 cache before the first request, `cache.edge.bypass` for middleware gates, `.ts` extensions inside `hypdriv.config.ts`, HTTPS at the zone, secrets) and the probes that prove each one.

## 3. Configure

All configuration lives in `hypdriv.config.ts`. Read `docs/guides/configuration.md` in the HypDriv repository (https://github.com/avonao/hypdriv/blob/main/docs/guides/configuration.md) for every key. Typical edits:

- **Allow a third-party script**: `security.csp.allow.scripts: ['https://js.stripe.com']` (and `frames` for iframes).
- **Cache a route at the edge**: `cache.edge.policies: [{ match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] }]`; purge with `revalidateTag('blog')` from `hypdriv/cache`.
- **Rate limit an API**: `security.rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] }]`.
- **Feature flag**: `flags.definitions.newCheckout = { default: false, rules: [{ when: { country: ['US'] }, percentage: 25, value: true }] }`; read with `await flag('newCheckout')` on the server or `useFlag('newCheckout')` on the client.
- **Cron job**: `jobs.cron.digest = { cron: '0 9 * * 1', path: '/api/jobs/digest' }`, add the cron to `wrangler.jsonc#triggers.crons` on Cloudflare or `vercel.json#crons` on Vercel (or run `hypdriv doctor --fix`), implement the route with `jobHandler()` from `hypdriv/server` and export it as both `GET` (Vercel Cron, `CRON_SECRET`) and `POST`.
- **Vercel CDN caching**: on Vercel, explicit policies with `respectOrigin: false` become `Vercel-CDN-Cache-Control` route headers at build time; wrap Route Handlers with `withVercelCdn(config, handler)` from `hypdriv/vercel`. Upstash (`KV_REST_API_URL`/`KV_REST_API_TOKEN`) gives exact rate limits; `GLOBAL_CONFIG` backs flags/redirects/maintenance.
- **Purser CSS**: `purser: { tokens: 'lib/tokens.ts', src: ['app','components','lib'], out: 'app/purser.css', theme: { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light', clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } } } } } }`.

Rules of thumb:
- Keep CSP in `auto` mode; add sources with `allow.*` rather than replacing `directives`.
- Do not disable `security.shield` or `security.headers` to fix a symptom; add a route override instead.
- Prefer `ensureStatic` (Next.js) + inferred edge policies over manual `ttl` for static pages.
- Prerendered pages of Vite hosts are served by the platform's static layer with a hash CSP; HypDriv infers no edge-cache policy for them (`servedStatically` in `hypdriv routes`).
- Leave `redirects.forceHttps` at `auto` (on for Cloudflare and Vercel, follows `site.origin`); on Cloudflare also turn on the zone's *Always Use HTTPS*, because Workers Static Assets answer before the Worker — `hypdriv audit https` checks it.

## 4. Verify

```sh
pnpm build                              # next build / vite build → .hypdriv/manifest.json
npx hypdriv routes                      # classification, cache policy, CSP mode per route
npx hypdriv analyze                     # Worker weight (Cloudflare) or function sizes (Vercel, after `vercel build`), per-route JS/CSS, budgets
pnpm preview &                          # Cloudflare: opennextjs-cloudflare build && preview → :8787
pnpm start &                            # Vercel / Node: next start → :3000
npx vite preview &                      # Vite hosts on Cloudflare (workerd); `npx hypdriv serve` for a plain Vite app on Node
npx hypdriv audit all --url http://localhost:8787   # headers, csp, cache, https
npx hypdriv audit css --url http://localhost:8787   # Purser zero-override check (needs Chrome)
```

Audits sign their requests with a short-lived token derived from `HYPDRIV_INTERNAL_SECRET` (from the environment, `.dev.vars` or `.env.local`), so the bot shield does not block headless Chrome; without the secret, a 403 from the shield is reported with that hint. On Vercel, the CSP audit warns (not fails) for ISR / PPR routes that use HypDriv's declared `'unsafe-inline'` fallback.

`hypdriv audit` exits non-zero on failures; fix the configuration and re-run. For CI add `npx hypdriv doctor --ci` and `npx hypdriv budget --ci`.

## 5. Diagnose at runtime

- Every response carries `Server-Timing` (stage timings), `x-hypdriv-cache` (HIT/MISS/STALE/BYPASS, `CDN` on Vercel), `x-hypdriv-csp` (nonce/hash/report-only/unsafe-inline-fallback), `x-request-id`.
- `/_hypdriv/health` lists the capabilities in use and which binding or platform service backs each one.
- In development open the HUD (Alt+Shift+H) or render `<HypDrivDevTools />` from `hypdriv/client` in the root layout.
- CSP violations are collected at `/_hypdriv/csp-report`; `npx hypdriv csp suggest` proposes allow-list additions from collected reports.
- Web Vitals are posted to `/_hypdriv/vitals`; `npx hypdriv vitals` prints p75 per route when Analytics Engine is bound.

## 6. Upgrading

Run `npx hypdriv deps` to see outdated dependencies (HypDriv, Next.js, OpenNext, wrangler). Apply patch/minor updates directly (`--update safe`); for majors read the linked changelogs and run `hypdriv doctor` afterwards.

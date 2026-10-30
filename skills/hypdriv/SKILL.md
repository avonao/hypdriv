---
name: hypdriv
description: Adopt, configure and operate HypDriv (the Hyper-Extension for Next.js 16+ on Cloudflare Workers) in a Next.js application — install, wire next.config/proxy/worker entry, tune caching, CSP, rate limits, flags, Purser CSS and observability, and verify with the hypdriv CLI.
---

# HypDriv for coding agents

Use this skill when a Next.js 16+ project should run on Cloudflare Workers with HypDriv, or when an existing HypDriv setup needs configuration, diagnosis or verification.

## 1. Detect the situation

```sh
npx hypdriv doctor --json
```

The JSON report tells you: Next.js version and config, whether `@opennextjs/cloudflare` is installed, whether `withHypDriv` wraps `next.config`, whether `hypdriv.worker.ts` is the Worker entry, wrangler compatibility (date/flags/bindings), deprecated features in use (`middleware.ts`, Edge runtime segments), Purser status, bundle sizes against limits, secrets exposure, and header posture. Each check has `id`, `status` (`pass|warn|fail|skip`), `message`, and `fix` (a shell command or a file edit description).

## 2. Install and wire (new projects)

```sh
npm create hypdriv@latest my-app -- --pm pnpm            # Next 16 + OpenNext + HypDriv
# or in an existing OpenNext project:
pnpm add hypdriv && npx hypdriv init
```

`hypdriv init` is idempotent. It:
1. writes `hypdriv.config.ts` (`defineConfig({...})`) with commented defaults,
2. wraps `next.config.ts` in `withHypDriv()` (keeps existing options),
3. writes `hypdriv.worker.ts` and sets `wrangler.jsonc#main` to it (keeps OpenNext's Durable Object exports),
4. writes `proxy.ts` with `createProxy()` when none exists,
5. adds scripts: `hypdriv:doctor`, `hypdriv:analyze`, `hypdriv:audit`,
6. optionally scaffolds the Purser bridge when `@avonao/purser` is installed.

Never hand-edit `.hypdriv/` — it is build output.

## 3. Configure

All configuration lives in `hypdriv.config.ts`. Read `docs/guides/configuration.md` in the HypDriv repository (or `node_modules/hypdriv/docs/configuration.md`) for every key. Typical edits:

- **Allow a third-party script**: `security.csp.allow.scripts: ['https://js.stripe.com']` (and `frames` for iframes).
- **Cache a route at the edge**: `cache.edge.policies: [{ match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] }]`; purge with `revalidateTag('blog')` from `@hypdriv/next/cache`.
- **Rate limit an API**: `security.rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] }]`.
- **Feature flag**: `flags.definitions.newCheckout = { default: false, rules: [{ when: { country: ['US'] }, percentage: 25, value: true }] }`; read with `await flag('newCheckout')` on the server or `useFlag('newCheckout')` on the client.
- **Cron job**: `jobs.cron.digest = { cron: '0 9 * * 1', path: '/api/jobs/digest' }`, add the cron to `wrangler.jsonc#triggers.crons` (or run `hypdriv doctor --fix`), implement the route with `jobHandler()` from `@hypdriv/next/server`.
- **Purser CSS**: `purser: { tokens: 'lib/tokens.ts', src: ['app','components','lib'], out: 'app/purser.css', theme: { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light', clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } } } } } }`.

Rules of thumb:
- Keep CSP in `auto` mode; add sources with `allow.*` rather than replacing `directives`.
- Do not disable `security.shield` or `security.headers` to fix a symptom; add a route override instead.
- Prefer `ensureStatic` (Next.js) + inferred edge policies over manual `ttl` for static pages.

## 4. Verify

```sh
pnpm build                              # next build → .hypdriv/manifest.json
npx hypdriv routes                      # classification, cache policy, CSP mode per route
npx hypdriv analyze                     # Worker weight, per-route JS/CSS, budgets
pnpm preview &                          # opennextjs-cloudflare build && preview
npx hypdriv audit all --url http://localhost:8787
npx hypdriv audit css --url http://localhost:8787   # Purser zero-override check (needs Chrome)
```

`hypdriv audit` exits non-zero on failures; fix the configuration and re-run. For CI add `npx hypdriv doctor --ci` and `npx hypdriv budget --ci`.

## 5. Diagnose at runtime

- Every response carries `Server-Timing` (stage timings), `x-hypdriv-cache` (HIT/MISS/STALE/BYPASS + reason), `x-hypdriv-csp` (nonce/hash/report-only), `x-request-id`.
- In development open the HUD (Alt+Shift+H) or render `<HypDrivDevTools />` from `@hypdriv/next/client` in the root layout.
- CSP violations are collected at `/_hypdriv/csp-report`; `npx hypdriv csp suggest` proposes allow-list additions from collected reports.
- Web Vitals are posted to `/_hypdriv/vitals`; `npx hypdriv vitals` prints p75 per route when Analytics Engine is bound.

## 6. Upgrading

Run `npx hypdriv deps` to see outdated dependencies (HypDriv, Next.js, OpenNext, wrangler). Apply patch/minor updates directly (`--update safe`); for majors read the linked changelogs and run `hypdriv doctor` afterwards.

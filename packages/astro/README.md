# @hypdriv/astro

HypDriv for [Astro](https://astro.build) 7 on Cloudflare Workers, Vercel and Node. One integration runs the HypDriv Drivetrain — security headers, CSP (per-request nonces or build-time hashes), rate limiting, bot shield, geo, feature flags, i18n, redirects, maintenance mode, edge cache, Early Hints, logging, tracing and `Server-Timing`, plus the `/_hypdriv/*` internal routes — around every route Astro renders on demand, and writes the route manifest and the static header rules of your adapter's platform after the build.

```sh
pnpm add @hypdriv/astro @hypdriv/core
```

```js
// astro.config.mjs
import cloudflare from '@astrojs/cloudflare'; // or @astrojs/vercel, @astrojs/node
import hypdriv from '@hypdriv/astro';
import { defineConfig } from 'astro/config';

export default defineConfig({
  adapter: cloudflare(),
  integrations: [hypdriv()],
});
```

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'my-site' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
});
```

## What the integration does

| Hook | Work |
| --- | --- |
| `astro:config:setup` | loads `hypdriv.config.*`, adds the Vite plugins that serve `virtual:hypdriv/config`, `virtual:hypdriv/manifest` and `virtual:hypdriv/astro`, registers the HypDriv middleware (`order: 'pre'`) and injects the on-demand route `/_hypdriv/[...path]` |
| `astro:routes:resolved` | converts Astro's routes (`[param]`, `[...rest]`, mixed segments such as `[slug].json`) into the manifest's routes |
| `astro:build:ssr` | records the stylesheets and scripts of on-demand pages (Early Hints, preload candidates) |
| `astro:build:done` | after the adapter: writes `.hypdriv/manifest.json` (routes, classifications, CSP hashes of every prerendered document, Early Hints), the static rules for the platform — Cloudflare `_headers`, Vercel Build Output header routes (and the error route's CSP), `@astrojs/node`'s `_headers.json` — and patches the final manifest into every server output (`dist/server`, `.vercel/output/functions/**`). Fails the build on budget, Purser or secrets-scan failures |

## Entry points

| Import | Use |
| --- | --- |
| `@hypdriv/astro` | `hypdriv(options)` (default export): `config` (file or inline object), `targets` (`cloudflare` / `vercel` / `node`; default: the adapter's platform), `internalRoutes` (default `true` with an adapter) |
| `@hypdriv/astro/server` | `hyp()`, `requireHyp()`, `nonce()`, `flag()`, `geo()`, `defer()`, `jobHandler()`, `jobRoute()` (an Astro endpoint for signed jobs and Vercel Cron) |
| `@hypdriv/astro/fetch` | `withHypDriv(handle)` for `src/fetch.ts`: the pipeline around Astro's whole request handling, so unmatched URLs, config redirects and trailing-slash redirects run through it too |
| `@hypdriv/astro/virtual` | types of the virtual modules, for a custom Cloudflare Worker entry |

```astro
---
import { flag, hyp } from '@hypdriv/astro/server';
export const prerender = false;
const ctx = hyp();
---
<p>Request {ctx?.requestId} · new hero: {String(flag('newHero', false))}</p>
```

## Cloudflare: the Worker shell

Own the Worker entry to get HypDriv's Durable Objects, `scheduled` / `queue` / `email` handlers and the pipeline in front of prerendered pages:

```ts
// src/worker.ts — wrangler.jsonc: "main": "./src/worker.ts", "assets": { "binding": "ASSETS", "run_worker_first": ["/*", "!/_astro/*"] }
/// <reference types="@hypdriv/astro/virtual" />
import { handle } from '@astrojs/cloudflare/handler';
import { createWorker } from '@hypdriv/cloudflare';
import config from 'virtual:hypdriv/config';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

// Astro's handler is typed with @cloudflare/workers-types; the shell passes the same request, env and ctx.
type AstroHandle = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

export default createWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  app: async () => ({ fetch: (request, env, ctx) => (handle as AstroHandle)(request, env, ctx) }),
});
```

The middleware inside Astro passes through there: the shell already ran the stages.

## CSP

- **Astro's `security.csp` off (default):** HypDriv owns the policy. On-demand responses get a per-request nonce, injected into every `<script>` (and `<style>` unless `unsafeInlineStyles`), `is:inline` scripts included — with `HTMLRewriter` on Workers, with a streaming tokenizer on Vercel and Node. `hyp().nonce` / `nonce()` give it to code that renders its own tags. Prerendered pages get a hash policy computed from their HTML, through the platform's static rules (and through the Worker shell on Cloudflare).
- **Astro's `security.csp` on:** Astro owns the policy (hashes in a `<meta>` tag on prerendered pages, a header on on-demand ones). The integration switches HypDriv's CSP off everywhere — middleware, `src/fetch.ts`, the Worker shell and the static rules — so no response carries two policies; every other header stays.

## Guide

Setup per platform, what runs where, error pages and limitations: [docs/guides/astro.md](../../docs/guides/astro.md).

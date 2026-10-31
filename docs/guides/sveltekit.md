# SvelteKit

`@hypdriv/sveltekit` integrates HypDriv with SvelteKit 3 (Svelte 5, Vite 8) on Cloudflare Workers, Vercel and Node. It follows the Vite host recipe of [ADR 0019](../adr/0019-vite-hosts.md): a wrapper around your SvelteKit adapter discovers the routes and prerendered pages, finalises the manifest, patches it into the server output and writes the platform's static headers; a `handle` hook runs the Drivetrain around every response SvelteKit renders. The runnable example is [`examples/sveltekit`](../../examples/sveltekit).

## Install

```sh
pnpm add @hypdriv/sveltekit @hypdriv/core
```

Requirements: `@sveltejs/kit` 3, Vite 8, Node 22.17+. SvelteKit 3 has no `svelte.config.js`: its options go to `sveltekit({ … })` in `vite.config.ts`.

```ts
// vite.config.ts
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { hypdriv } from '@hypdriv/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit({ adapter: hypdriv(adapter()) })],
});
```

```ts
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { hypdriv } from '@hypdriv/sveltekit/hooks';

export const handle = sequence(hypdriv(), authHandle, i18nHandle);
```

Put `hypdriv()` first: it owns the full response, and the handles after it run inside the HypDriv request context (`hyp()`), see the forwarded request and can still rewrite the response. `hypdriv.config.ts` in the project root is the HypDriv config ([configuration](./configuration.md)); `hypdriv(adapter(), { config: './config/hypdriv.ts' })` points elsewhere or takes an inline config.

Server code (load functions, actions, `+server` endpoints, remote functions, server-rendered components) imports the request helpers from `@hypdriv/sveltekit/server`:

```ts
import { defer, flag, geo, hyp, jobHandler, nonce, requireHyp } from '@hypdriv/sveltekit/server';
```

## How it works

### Build

The wrapper adapter (`hypdriv(adapter(), options)`) keeps everything the inner adapter does (its `emulate`, `supports`, and Vite settings such as adapter-cloudflare's `cloudflare:workers` emulation) and adds:

1. **Vite plugins**, contributed through the adapter's `vite.plugins.pre`: HypDriv's host plugin (`virtual:hypdriv/config`, `virtual:hypdriv/manifest`, `ssr.noExternal` for `@hypdriv/sveltekit` so the hook bundles with SvelteKit's `$app/env`) and `virtual:hypdriv/sveltekit`, which carries SvelteKit's `csp` option into the hook. In `vite dev` and the server build, the manifest lists the routes found in `src/routes` (pages and `+server` endpoints, route groups removed, matchers dropped, `[[optional]]` and `[...rest]` kept).
2. **After SvelteKit built and prerendered the app, before the adapter runs**: routes from `builder.routes` (pages, endpoints, `prerender = true`, adapter-vercel `isr` as `isr`; segments that mix parameters and text such as `[slug]-[id]` match with SvelteKit's own regex), client assets per route from SvelteKit's server output (Early Hints, budgets), the prerendered pages (asset URLs made root-relative for discovery; SvelteKit writes relative ones by default), CSP hashes of each prerendered page plus the hashes of SvelteKit's `<meta>` policy, then `finalizeManifest()`: `.hypdriv/manifest.json`, `.hypdriv/report.md`, budgets, Purser verification and the secrets scan. Failures fail the build. The final manifest is patched into `.svelte-kit/output/server`, which every adapter copies or bundles.
3. **The adapter runs**, then HypDriv writes the platform's static headers, patches every server output the deployment uses again and verifies that each embedded manifest is the final one (the build fails otherwise).

### Runtime

`hypdriv()` from `@hypdriv/sveltekit/hooks` is SvelteKit's `handle` around `createHandler({ host: 'sveltekit' })` (runner `host`): upstream is `resolve(event)` with the forwarded request (body included), so the pipeline owns the full response — internal routes, the HTTPS upgrade, rate limits and bot verdicts before SvelteKit renders; security headers, CSP, edge cache, Early Hints and `Server-Timing` after. It passes straight through:

- while SvelteKit analyses and prerenders the app (`building` from `$app/env`, a module flag of the build process that no request can set), so prerendered HTML is never affected and `url.searchParams` is never read during prerendering;
- for SvelteKit's internal sub-requests (`event.fetch` to the app itself);
- inside an outer HypDriv runner — the Cloudflare Worker shell or HypDriv's Node server — which already ran the stages around the request.

Platform inputs: on Cloudflare `env` and `waitUntil` come from `cloudflare:workers` and geo from `request.cf` (SvelteKit 3 no longer fills `event.platform` there); on Vercel `waitUntil` comes from Vercel's request context; on Node the client address is SvelteKit's (`getClientAddress()`, which honours adapter-node's `ADDRESS_HEADER` / `XFF_DEPTH`), elsewhere the platform's headers are used.

## Cloudflare

```ts
import adapter from '@sveltejs/adapter-cloudflare';
sveltekit({ adapter: hypdriv(adapter()) });
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": ".svelte-kit/cloudflare/_worker.js",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare" },
  "durable_objects": {
    "bindings": [
      { "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" },
      { "name": "HYPDRIV_INDEX", "class_name": "HypDrivIndex" },
      { "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }
    ]
  },
  "migrations": [{ "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }]
}
```

`vite build` then `wrangler dev` / `wrangler deploy`.

- **Worker shell.** adapter-cloudflare generates a Worker with only a `fetch` handler and overwrites `main`. In Workers mode HypDriv moves it to `_sveltekit_worker.js` (added to `.assetsignore`) and writes HypDriv's shell in its place: `createSvelteKitWorker()` (`createWorker({ app })` from `@hypdriv/cloudflare`) with the final manifest, the config (imported from `hypdriv.config.ts` through `.svelte-kit/hypdriv/worker-config.js`) and SvelteKit's `csp` directives. The shell runs the Drivetrain for every request the Worker receives — including the CSRF rejections, trailing-slash redirects and `/_app` 404s SvelteKit answers before `handle` — adds `scheduled`, `queue`, `email` and `tail` handlers (jobs from `hypdriv.config` dispatched to `jobHandler` endpoints) and exports `HypDrivLimiter`, `HypDrivIndex` and `HypDrivChannel`. Bindings found at run time upgrade rate limiting, tag purges and live channels (see [Cloudflare](./cloudflare.md)). The in-app `handle` passes through inside it.
- **Your own Durable Objects, Workflows and entrypoints**: `hypdriv(adapter(), { cloudflare: { exports: 'src/worker-exports.ts' } })` re-exports that module's named exports from the Worker.
- **Static files and prerendered pages** are served by Workers Static Assets before the Worker. HypDriv writes its rules into the adapter's `_headers` (merged with yours and the adapter's, within Cloudflare's 100-rule limit): the security preset on `/*`, and per prerendered page its hash CSP (`x-hypdriv-csp: hash`), `Reporting-Endpoints` and the Early Hints `Link`. `/_app/immutable/*` caching stays the adapter's. To run the request-time stages (rate limits, bot shield, geo, flags) for those requests too, set `"run_worker_first": true` in `assets`; the shell then serves them through the pipeline.
- **Pages mode** (no `main`/`assets` in the wrangler config, or `pages_build_output_dir`): `_headers` and the in-app `handle` apply; the shell is off by default (Pages Functions cannot export Durable Objects or cron handlers). `cloudflare: { worker: true }` turns it on for `fetch`.
- **Development**: `vite dev` emulates `cloudflare:workers` through adapter-cloudflare's platform proxy; the `handle` runs the pipeline with per-isolate stores. wrangler warns that the HypDriv Durable Objects are not exported there — they are only in the built Worker.

## Vercel

```ts
import adapter from '@sveltejs/adapter-vercel';
sveltekit({ adapter: hypdriv(adapter()) });
```

`vite build` (Vercel sets `VERCEL=1`) writes `.vercel/output` through adapter-vercel. The functions run the `handle`; Vercel's CDN follows the cache headers the pipeline sets inside them (`responseOwner`). HypDriv inserts its header routes into `config.json` — the security preset for every response, and the hash CSP and Early Hints of each prerendered page — before adapter-vercel's prerender rewrites, so they apply to the CDN's static files and to responses the functions send before `handle` (CSRF rejections, trailing-slash redirects). Static files and prerendered pages are served by the CDN without request-time stages (rate limits and the bot shield apply to function requests). ISR routes (`export const config = { isr: { expiration: 60 } }`) are classified `isr`. The edge runtime no longer exists in adapter-vercel 7; functions use Node.

## Node

```ts
import adapter from '@sveltejs/adapter-node';
sveltekit({ adapter: hypdriv(adapter()) });
```

```js
// server.js
import { serve } from '@hypdriv/sveltekit/node';
await serve({ dir: 'build' });
```

`vite build && node server.js`. `serve()` (and `createRequestListener()` for your own `http` server or framework) imports adapter-node's `build/handler.js` and runs the pipeline around all of it: prerendered pages get their hash CSP from the manifest, static files the security preset, and every request the request-time stages. adapter-node keeps serving files (precompressed variants, ETags, ranges) and reading its environment (`BODY_SIZE_LIMIT`, `PROTOCOL_HEADER`, `HOST_HEADER`, `ADDRESS_HEADER`, `XFF_DEPTH`); HTML navigations are requested uncompressed so the pipeline can add nonces. The server shares the handler the `handle` hook created (config, manifest, stores) and the hook passes through inside it. `PORT`, `HOST`, `SOCKET_PATH` and `SHUTDOWN_TIMEOUT` work as with adapter-node; behind a reverse proxy set `HYPDRIV_TRUST_PROXY=1` (or `trustProxy: true`). `node build` (adapter-node's own server) also works: then only the responses SvelteKit renders through `handle` get the pipeline.

## CSP

HypDriv emits one policy per response, built from `security.csp` in `hypdriv.config`:

- **Dynamic responses** use a per-request nonce (`nonce()`, `hyp().nonce`). HypDriv adds it to every `<script>`, `<link rel="modulepreload">` (and `<style>` when `unsafeInlineStyles` is off) in the streamed HTML — SvelteKit's hydration script, the scripts that stream `load` promises after the shell, Svelte's `hydratable` script — with `HTMLRewriter` on Cloudflare and a streaming tokenizer elsewhere. Inline scripts of your own use `nonce()`.
- **Prerendered pages** use hashes of their inline scripts, served from the static rules (and from the manifest when the Worker shell or the Node server serves them).
- **SvelteKit's `csp` option** is supported. Its `directives` are folded into HypDriv's (`'self'` → `'self'` quoting included); on dynamic responses SvelteKit's nonce is replaced by HypDriv's throughout the streamed body and SvelteKit's header is dropped, so the page, `%sveltekit.nonce%`, `nonce()` and the policy agree; on prerendered pages SvelteKit's `<meta http-equiv>` policy stays in the HTML (browsers enforce it together with the header) and its hashes are added to the page's static policy. SvelteKit's `reportOnly` policy is replaced by HypDriv's `security.csp.reportOnly` (the build warns), and its `report-to` by HypDriv's reporting endpoint.
- **`security.csp: false`** turns HypDriv's policy off; SvelteKit's own policy (if any) applies unchanged. A route override with `mode: 'off'` does the same per path.

## Limitations

- `%sveltekit.nonce%` in `app.html` carries HypDriv's nonce only when SvelteKit's `csp` option sets `script-src` (or `default-src`): without it SvelteKit sends no policy, so its nonce cannot be read. SvelteKit itself forbids `%sveltekit.nonce%` with prerendered pages.
- Links to `/_hypdriv/*` from prerendered pages need `rel="external"` (or `prerender.handleHttpError`): SvelteKit's crawler would request them during the build, where the hook passes through.
- Data requests (`/route/__data.json`) and remote function calls run the pipeline but are not matched to a page route (route-level CSP and cache policies do not apply to them; they are not HTML).
- On Vercel, `@vercel/nft` reports that it cannot locate `cloudflare:workers`: the runtime imports it only on workerd, the warning is harmless.
- adapter-vercel's `config.json` header routes, Vercel's CDN behaviour and the Cloudflare production edge (`_headers`, `run_worker_first`) are verified locally (`wrangler dev`, invoking the function) and by the live suites, not at build time.

# @hypdriv/sveltekit

Hypdriv for [SvelteKit](https://svelte.dev/docs/kit) 3 on Cloudflare Workers, Vercel and Node. It runs the Hypdriv Drivetrain — security headers, CSP with build-time hashes or per-request nonces, rate limiting, the bot shield, geo, feature flags, i18n, redirects, maintenance mode, the edge cache, Early Hints, logging/tracing/`Server-Timing` and the `/_hypdriv/*` routes — around every response of a SvelteKit app, and gives prerendered pages and static files their headers through the platform's static configuration.

```sh
pnpm add @hypdriv/sveltekit @hypdriv/core
```

## Setup

```ts
// vite.config.ts
import adapter from '@sveltejs/adapter-cloudflare'; // or -vercel, -node
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

export const handle = sequence(hypdriv(), /* your hooks */);
```

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';
export default defineConfig({
  security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }] },
  performance: { earlyHints: true },
});
```

Server code reads the request context from `@hypdriv/sveltekit/server`:

```ts
// src/routes/+page.server.ts
import { flag, hyp, nonce } from '@hypdriv/sveltekit/server';
export const load = () => ({ requestId: hyp()?.requestId, nonce: nonce(), newHero: flag('newHero', false) });
```

## Entry points

| Import | What it is |
| --- | --- |
| `@hypdriv/sveltekit` | `hypdriv(adapter, options?)`: the wrapper adapter. It contributes Hypdriv's Vite plugins (config and manifest modules, `ssr.noExternal`) and, after SvelteKit built and prerendered the app, writes `.hypdriv/manifest.json`, patches the final manifest into the server output, runs your adapter, writes the platform's static headers and (Cloudflare Workers) the Worker shell. Also exports the toolkit it is built from (`routesFromBuilder`, `svelteKitPattern`, `routeAssets`, `withSvelteKitCsp`, `adoptSvelteKitCsp`, …). |
| `@hypdriv/sveltekit/hooks` | `hypdriv(options?)`: the `handle` hook, built on `createHandler()` (`runner: 'host'`). Options: `stages`, `onError`, `skip`, `target`, `development`, `platform`, `devState`. |
| `@hypdriv/sveltekit/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler`. |
| `@hypdriv/sveltekit/worker` | `createSvelteKitWorker()`: the Cloudflare Worker entry the build generates (Hypdriv's `createWorker` around adapter-cloudflare's Worker). |
| `@hypdriv/sveltekit/durable-objects` | `HypDrivLimiter`, `HypDrivIndex`, `HypDrivChannel`, re-exported for that entry. |
| `@hypdriv/sveltekit/node` | `serve()` / `createRequestListener()`: adapter-node's `build/handler.js` behind the pipeline. |

## Adapter options

| Option | Description |
| --- | --- |
| `config` | Hypdriv config file path or inline config (default `hypdriv.config.*`) |
| `target` | `cloudflare` \| `vercel` \| `node` (default: from the adapter's name; `adapter-auto` by its environment) |
| `cloudflare.worker` | wrap adapter-cloudflare's Worker in Hypdriv's Worker shell (default: true for Workers, false for Pages) |
| `cloudflare.exports` | a module whose named exports the Worker re-exports (your Durable Objects, Workflows, entrypoints) |
| `cloudflare.wranglerConfig` | the wrangler config, when you pass `config` to adapter-cloudflare |
| `node.out` | adapter-node's `out` (default `build`) |

## What runs where

| | Cloudflare (adapter-cloudflare, Workers) | Vercel (adapter-vercel) | Node (adapter-node) |
| --- | --- | --- | --- |
| Dynamic pages, endpoints, actions, remote functions | Worker shell; `handle` passes through | `handle` in the function | `@hypdriv/sveltekit/node` around `build/handler.js`; `handle` passes through (or `handle` alone with `node build`) |
| Responses SvelteKit sends before `handle` (CSRF 403, trailing-slash 308, `/_app` 404) | Worker shell | static header routes (`config.json`) | `@hypdriv/sveltekit/node` |
| Prerendered pages, static files | `_headers` (hash CSP per page, security preset, Early Hints) | `config.json` header routes | `@hypdriv/sveltekit/node` (hash CSP from the manifest) |
| `scheduled` / `queue` / `email`, Durable Objects | Worker shell | Vercel Cron → `jobHandler` | — |

## CSP

Hypdriv owns the policy. Dynamic responses get a per-request nonce that Hypdriv adds to every `<script>`, `<link rel="modulepreload">` and (without `unsafeInlineStyles`) `<style>` the response streams, including SvelteKit's streamed `load` data; prerendered pages get a hash policy from their inline scripts. When you also set SvelteKit's `csp` option, its directives join Hypdriv's policy, SvelteKit's nonce is replaced by Hypdriv's in the streamed body (so `nonce()`, `%sveltekit.nonce%` and SvelteKit's scripts all carry the same value) and only Hypdriv's header is sent; the hashes of SvelteKit's `<meta>` policy in prerendered pages are added to their static policy. With `security.csp: false`, SvelteKit's own policy applies unchanged. See [docs/guides/sveltekit.md](../../docs/guides/sveltekit.md).

## License

MIT

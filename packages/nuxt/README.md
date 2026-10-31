# @hypdriv/nuxt

HypDriv for Nuxt 4: a Nuxt module that runs the HypDriv Drivetrain — security headers, CSP (nonces for rendered pages, hashes for prerendered ones), rate limiting, the bot shield, geo, feature flags, i18n, redirects, maintenance mode, Early Hints, logging, tracing, Server-Timing and the `/_hypdriv/*` routes — around every Nitro response, and writes the build manifest and the platform's static headers for **Cloudflare Workers**, **Vercel** and **Node**.

Requires Nuxt 4.6+ (Nitro 2, h3 1.x).

```sh
pnpm add @hypdriv/nuxt @hypdriv/core
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@hypdriv/nuxt'],
});
```

```ts
// hypdriv.config.ts
import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }] },
  performance: { earlyHints: true },
});
```

## Platforms

| Preset | How the pipeline runs | Static headers |
|---|---|---|
| `cloudflare-module` | HypDriv's Worker entry: the Worker shell (`createWorker`) around Nitro, with `scheduled` / `queue` / `email` dispatch and the HypDriv Durable Objects exported | `_headers` in the assets directory |
| `vercel` | Inside the Nitro function (it owns the response) | Build Output `config.json` header routes |
| `node-server` | Inside Nitro, for every request except build assets | — (prerendered pages are served through the pipeline) |

Other Cloudflare presets (`cloudflare-pages`, `cloudflare-durable`) and `hypdriv.cloudflare.worker: false` use the in-app hook. `nuxt dev` runs the pipeline too (`hypdriv.dev: false` turns it off).

## Options (`hypdriv` in `nuxt.config.ts`)

| Option | Default | |
|---|---|---|
| `config` | `hypdriv.config.*` in the root | Config file path or inline config |
| `dev` | `true` | Run the pipeline in `nuxt dev` |
| `nonce` | `true` | Nuxt stamps the request's CSP nonce on every tag it renders through unhead |
| `staticHeaders` | `true` | Write `_headers` / `config.json` header routes |
| `cloudflare.worker` | `true` | Use HypDriv's Worker entry for `cloudflare-module` |
| `cloudflare.exports` | — | Module whose named exports the Worker entry re-exports (your Durable Objects, Workflows…) |

## Request context

```ts
// server/api/whoami.get.ts — server code
import { flag, hyp } from '@hypdriv/nuxt/server';
import { defineEventHandler } from 'nuxt/server';

export default defineEventHandler(() => ({ requestId: hyp()?.requestId, newHero: flag('newHero', false) }));
```

```vue
<!-- components: auto-imported composables -->
<script setup lang="ts">
const hyp = useHyp(); // request id, runner, route, country, locale, CSP mode, public flags
</script>
```

`@hypdriv/nuxt/server` exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler`; components get `useHyp()` and `useHypNonce()`.

## How it works

- **Runtime:** a Nitro plugin wraps Nitro's h3 app handler. Request stages run first and may answer on their own; otherwise Nitro renders into a capture response inside the request's `AsyncLocalStorage` context, and the response stages post-process the captured head and streaming body before it reaches the client. Nuxt's error pages render inside the same capture. While Nuxt prerenders the plugin is not installed (`import.meta.prerender` is a build-time constant).
- **CSP:** dynamic pages use a per-request nonce that Nuxt stamps on its tags (unhead's `tags:afterResolve`) and the pipeline injects everywhere else; prerendered pages use the hashes computed at build time; renders Nitro caches are never stamped; an application-set policy is kept.
- **Build:** pages (`pages:resolved`), Nitro server routes, prerendered documents and Nuxt's client manifest become `.hypdriv/manifest.json`; the server bundle embeds the final manifest (verified in every output file after the build), and the static header rules go into `_headers` or `config.json`.

See [the Nuxt guide](../../docs/guides/nuxt.md) for setup per platform, what runs where and the limitations, and [`examples/nuxt`](../../examples/nuxt) for an app that builds for all three platforms.

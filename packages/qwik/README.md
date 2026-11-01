# @hypdriv/qwik

Hypdriv for [Qwik](https://qwik.dev) (Qwik v2 and Qwik Router, on Vite) on Cloudflare Workers, Vercel and Node: the Drivetrain — the HTTPS upgrade, security headers, CSP with per-request nonces and hashes of prerendered pages, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — around Qwik Router's request handler, plus the route manifest, CSP hashes and static headers from the Qwik build.

Full guide: [`docs/guides/qwik.md`](../../docs/guides/qwik.md). Example: [`examples/qwik`](../../examples/qwik). Design: [ADR 0023](../../docs/adr/0023-qwik-host.md).

Three pieces, each in the place Qwik already has for it:

```ts
// vite.config.ts — the plugin: route manifest, CSP hashes, platform static headers, the dev pipeline
import { hypdriv } from '@hypdriv/qwik';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikRouter } from '@qwik.dev/router/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [qwikRouter(), qwikVite(), hypdriv()] });
```

```ts
// adapters/node/vite.config.ts — a Qwik Router adapter (…/vercel, …/cloudflare)
import { nodeAdapter } from '@hypdriv/qwik/adapters/node';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config';

export default extendConfig(baseConfig, () => ({
  build: { ssr: true, rolldownOptions: { input: ['src/entry.node.tsx'] } },
  plugins: [nodeAdapter({ ssg: { include: ['/*'], exclude: ['/api/*'] } })],
}));
```

```tsx
// src/entry.node.tsx — the server entry (…/middleware/vercel, …/middleware/cloudflare)
import { createServer } from 'node:http';
import { createQwikRouter } from '@hypdriv/qwik/middleware/node';
import render from './entry.ssr';

const { listener } = createQwikRouter({ render });
createServer(listener).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
```

Build with `vite build && vite build -c adapters/<target>/vite.config.ts`. Prerendered pages are served as Qwik wrote them under a hash-based CSP; everything else renders per request under a nonce policy that Hypdriv injects into the streamed HTML (Qwik's own `nonce` option stays unused).

Requirements: `@qwik.dev/core` and `@qwik.dev/router` `>=2.0.0-rc.4 <3`, Vite 8, Node 20.19+. Qwik v1 (`@builder.io/qwik-city`) is not supported: it predates Vite 8 (`qwik migrate-v2` moves an application).

## Exports

| Entry | Export | Purpose |
| --- | --- | --- |
| `@hypdriv/qwik` | `hypdriv(options)` | the Vite plugin (manifest, CSP hashes, static headers, Durable Object export, dev pipeline) |
| | `discoverRoutes`, `mergeRoutes`, `findDocuments` | routes from Qwik Router's route table, prerendered documents from the client build |
| | `detectTarget`, `resolveTarget`, `targetOfAdapter`, `ADAPTER_MODULES`, `ENTRY_NAMES` | target selection |
| `@hypdriv/qwik/adapters/node` `…/vercel` `…/cloudflare` | `nodeAdapter`, `vercelAdapter`, `cloudflareAdapter` | Qwik Router adapters (`viteAdapter`): static generation as Qwik does it, plus the platform output |
| `@hypdriv/qwik/middleware/node` `…/vercel` `…/cloudflare` | `createQwikRouter({ render, hypdriv })` | the server entry behind the Drivetrain: Node `listener`, Vercel function, Cloudflare Worker |
| `@hypdriv/qwik/durable-objects` | `HypDrivLimiter`, `HypDrivIndex`, `HypDrivChannel` | the Durable Object classes, for a Worker entry of your own |
| `@hypdriv/qwik/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` | request helpers for `routeLoader$`, `routeAction$`, `server$`, middleware and endpoints |

## Plugin options

| Option | Default | Purpose |
| --- | --- | --- |
| `config` | `hypdriv.config.*` | path to the Hypdriv config, or an inline config |
| `target` | the adapter that builds the server | `cloudflare`, `vercel` or `node` |
| `routes` | Qwik Router's route table | extra routes, or a function that returns the final list |
| `vercelMiddleware` | `true` | Vercel: Routing Middleware for the request stages over CDN-served pages |
| `durableObjects` | `true` | Cloudflare: export the Durable Object classes from the Worker entry |
| `dev` | `true` | run the pipeline around the dev server (`vite --mode ssr`) |

## License

MIT

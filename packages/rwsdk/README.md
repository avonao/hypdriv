# @hypdriv/rwsdk

Hypdriv for [RedwoodSDK](https://rwsdk.com) (React Server Components on Vite and Cloudflare Workers): the Drivetrain — the HTTPS upgrade, security headers, CSP with per-request nonces, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — around every request the Worker answers, plus the route manifest read from `defineApp([...])`, the client assets of the build and the static headers of the hashed assets.

Full guide: [`docs/guides/rwsdk.md`](../../docs/guides/rwsdk.md). Example: [`examples/rwsdk`](../../examples/rwsdk). Design: [ADR 0025](../../docs/adr/0025-rwsdk-host.md).

```ts
// vite.config.mts
import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/rwsdk';
import { redwood } from 'rwsdk/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  environments: { ssr: {} },
  plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()],
});
```

```tsx
// src/worker.tsx
import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
import { render, route } from 'rwsdk/router';
import { defineApp } from 'rwsdk/worker';

export default withHypDriv(
  defineApp([
    hypdrivMiddleware(), // first: RedwoodSDK renders with the nonce of Hypdriv's CSP
    render(Document, [route('/', Home)]),
  ]),
);
```

`withHypDriv()` puts the Drivetrain in front of `defineApp`'s `fetch` (and Hypdriv's jobs next to your own `scheduled`, `queue`, `email` and `tail` handlers). `hypdrivMiddleware()` hands the nonce the CSP issued to RedwoodSDK (`requestInfo.rw.nonce`), which RedwoodSDK puts on its RSC payload and hydration scripts; without it a nonce CSP blocks them, and the wrapper and the build say so. The plugin serves the config and manifest to the Worker, exports the Durable Object classes from the Worker entry and, after RedwoodSDK's multi-pass build, writes `.hypdriv/manifest.json`, patches it into `dist/worker` and writes `dist/client/_headers`.

Cloudflare Workers only: that is the only platform RedwoodSDK documents. Requirements: `rwsdk >=1.0.0 <2`, Vite 8, `@cloudflare/vite-plugin`, Node 22.12+.

## Exports

| Entry | Export | Purpose |
| --- | --- | --- |
| `@hypdriv/rwsdk` | `hypdriv(options)` | the Vite plugin (manifest, route discovery, static headers, Durable Object export); options `config`, `entry`, `routes`, `durableObjects` |
| | `scanWorkerRoutes`, `discoveredRoutes`, `findWorkerEntry`, `rwsdkPattern`, `appRoutes`, `appManifest` | route discovery from the Worker source and from a running app |
| `@hypdriv/rwsdk/worker` | `withHypDriv(app, options)`, `hypdrivMiddleware()` | the Worker wrapper (config and manifest come from the plugin) and the nonce hand-off |
| `@hypdriv/rwsdk/wrap` | `wrapApp(app, { config, manifest, … })` | the wrapper without the plugin's virtual modules (tests, your own bundling) |
| `@hypdriv/rwsdk/durable-objects` | `HypDrivLimiter`, `HypDrivIndex`, `HypDrivChannel` | the Durable Object classes, when you export them yourself (`durableObjects: false`) |
| `@hypdriv/rwsdk/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` | request helpers for server components, server functions and route handlers |

## License

MIT

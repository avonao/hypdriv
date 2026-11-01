# @hypdriv/waku

Hypdriv for [Waku](https://waku.gg) (React Server Components on Vite) on Cloudflare Workers, Vercel and Node: the Drivetrain — the HTTPS upgrade, security headers, CSP with per-request nonces and hashes of prerendered pages, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — around every request Waku answers, plus the route manifest, CSP hashes and static headers from the Waku build.

Full guide: [`docs/guides/waku.md`](../../docs/guides/waku.md). Example: [`examples/waku`](../../examples/waku). Design: [ADR 0021](../../docs/adr/0021-waku-host.md).

```ts
// waku.config.ts
import { withHypDriv } from '@hypdriv/waku';
import { defineConfig } from 'waku/config';

export default defineConfig(withHypDriv({}));
```

`withHypDriv()` selects the Hypdriv adapter of the build's target (`HYPDRIV_TARGET`, the Cloudflare Vite plugin, `VERCEL=1`, else Node) and adds the Vite plugin. With your own `src/waku.server.tsx`, import the adapter instead of Waku's:

```tsx
import adapter from '@hypdriv/waku/adapters/node'; // …/vercel, …/cloudflare
import { fsRouter } from 'waku';

export default adapter(fsRouter(import.meta.glob('./pages/**/*.{tsx,ts}')));
```

Requirements: `waku >=1.0.0-rc.4 <2`, Vite 8, Node 22.15+.

## Exports

| Entry | Export | Purpose |
| --- | --- | --- |
| `@hypdriv/waku` | `withHypDriv(config, options)` | wraps `waku.config.ts`: adapter + plugin |
| | `hypdriv(options)` | the Vite plugin alone (manifest, CSP hashes, static headers, Durable Object export) |
| | `discoverRoutes`, `discoverFileRoutes`, `scanCreatePages`, `pagePattern` | route discovery from `src/pages` and `createPage` / `createApi` calls |
| | `detectTarget`, `resolveTarget`, `ADAPTER_MODULES` | target selection |
| `@hypdriv/waku/adapters/node` `…/vercel` `…/cloudflare` | default `adapter(handlers, { …wakuOptions, hypdriv })` | Waku's adapter behind the Drivetrain |
| `@hypdriv/waku/durable-objects` | `HypDrivLimiter`, `HypDrivIndex`, `HypDrivChannel` | the Durable Object classes, for a Worker entry of your own |
| `@hypdriv/waku/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` | request helpers for server components, server functions and `_api` routes |

## License

MIT

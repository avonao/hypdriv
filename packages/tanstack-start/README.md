# @hypdriv/tanstack-start

HypDriv for [TanStack Start](https://tanstack.com/start) (React) on Cloudflare Workers, Vercel and Node: the Drivetrain — security headers, CSP with per-request nonces (handed to the router's `ssr.nonce`) or build-time hashes, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — as TanStack Start global request middleware, plus a Vite plugin that writes the route manifest after prerendering and the platform's static headers.

Full guide: [`docs/guides/tanstack-start.md`](../../docs/guides/tanstack-start.md).

## Setup

```ts
// vite.config.ts
import { hypdriv, withHypDriv } from '@hypdriv/tanstack-start/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';

export default defineConfig({
  plugins: [
    tanstackStart(withHypDriv({ prerender: { enabled: true }, pages: [{ path: '/about' }] })),
    // nitro() for Vercel / Node, or cloudflare({ viteEnvironment: { name: 'ssr' } }) first for Workers
    viteReact(),
    hypdriv(), // last
  ],
});
```

```ts
// src/start.ts — HypDriv first, then Start's CSRF protection for server functions
import { hypdrivRequestMiddleware } from '@hypdriv/tanstack-start';
const requestMiddleware = hypdrivRequestMiddleware();
export const startInstance = createStart(() => ({ requestMiddleware }));
```

```tsx
// src/router.tsx — the request's nonce on every tag the router renders
import { hypdrivSsr } from '@hypdriv/tanstack-start';
export const getRouter = () => createRouter({ routeTree, ssr: hypdrivSsr() });
```

```ts
// server functions, server routes
import { flag, hyp } from '@hypdriv/tanstack-start/server';
```

## Entry points

| Entry | Contents |
| --- | --- |
| `@hypdriv/tanstack-start` | `hypdrivRequestMiddleware()`, `hypdrivMiddleware()`, `createHypDrivMiddleware()`, `hypdrivSsr()`, `renderedManifest()`; inert stand-ins in the browser (`browser` export condition) |
| `@hypdriv/tanstack-start/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` |
| `@hypdriv/tanstack-start/vite` | `hypdriv()`, `withHypDriv()`, route discovery and output helpers |
| `@hypdriv/tanstack-start/cloudflare` | `createStartWorker()` (Worker shell around Start: `scheduled`/`queue`/`email`, Durable Objects), `startApp()` |
| `@hypdriv/tanstack-start/server-entry` | `src/server.ts` wrapper (`export { default } from …`), `createHypDrivServerEntry()` |

## Platforms

- **Cloudflare Workers** (`@cloudflare/vite-plugin`): `wrangler.jsonc` `main` is your `src/worker.ts` exporting `createStartWorker({ config, manifest })` and the HypDriv Durable Objects. The build writes `dist/client/_headers` (hash CSP of each prerendered page, security headers, immutable assets) and patches the manifest into `dist/server`.
- **Vercel** (Nitro `vercel` preset): header routes and clean-URL `overrides` in `.vercel/output/config.json`; the manifest is patched into the function.
- **Node** (Nitro `node-server`): `node .output/server/index.mjs`; `routeRules` for hashed assets. Prerendered pages are rendered per request on Node (Nitro builds its asset table before Start prerenders) and get a nonce policy.

Start's prerender requests carry a per-build token (`withHypDriv()`) and bypass the pipeline, so static documents never contain one request's nonce, id or flags; the token is removed from the server output after the build.

## License

MIT

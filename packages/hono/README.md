# @hypdriv/hono

Hypdriv for [Hono](https://hono.dev) on Cloudflare Workers, Vercel Functions, Node, Bun and Deno: the Drivetrain — the HTTPS upgrade, security headers, CSP with per-request nonces, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — as Hono middleware, or as a wrapper around the app's `fetch`.

Full guide: [`docs/guides/hono.md`](../../docs/guides/hono.md). Example: [`examples/hono`](../../examples/hono).

```ts
import { useHypDriv } from '@hypdriv/hono';
import { Hono } from 'hono';
import config from '../hypdriv.config';

const app = new Hono();
useHypDriv(app, { config });   // first: Hono middleware only wraps the routes registered after it
app.get('/', (c) => c.text('hello'));
export default app;
```

```ts
import { wrapHono } from '@hypdriv/hono';
export default wrapHono(app, { config });   // wraps the whole app and forwards the pipeline's request
```

## Exports

| Export | Purpose |
| --- | --- |
| `useHypDriv(app, options)` | registers the middleware and derives the route manifest from the app |
| `hypdriv(options)` | the middleware alone (`app.use(hypdriv({ config }))`) |
| `wrapHono(app, options)` | `{ fetch, handler }`: the app's `fetch` behind the Drivetrain |
| `honoManifest(app)`, `honoPattern(method, path)` | the route manifest and the Hono → Hypdriv path conversion |
| `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` | request helpers for code below the middleware |
| `HypDrivHonoVariables` | `c.get('hypdrivNonce')` |

## License

MIT

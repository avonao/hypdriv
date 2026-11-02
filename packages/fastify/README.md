# @hypdriv/fastify

Hypdriv for [Fastify 5](https://fastify.dev) on Node and Vercel Functions: the Drivetrain — the HTTPS upgrade, security headers, CSP with per-request nonces, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — as one encapsulation-breaking Fastify plugin.

Full guide: [`docs/guides/fastify.md`](../../docs/guides/fastify.md). Example: [`examples/fastify`](../../examples/fastify).

```ts
import { hypdriv } from '@hypdriv/fastify';
import Fastify from 'fastify';
import config from '../hypdriv.config';

const app = Fastify();
await app.register(hypdriv, { config });   // first: the hooks cover every route, in every context
app.get('/', async () => 'hello');
await app.listen({ port: 3000 });
```

`onRequest` runs the stages before the route (and answers itself for a rate limit, the HTTPS upgrade or an internal route); `onSend` hands what the route answered to the stages after it and sends their final response, streaming. The request body stays unread until a stage asks for it and goes back to Fastify's content-type parsers afterwards. Register `@fastify/compress` **after** the plugin.

## Exports

| Export | Purpose |
| --- | --- |
| `hypdriv` | the plugin (`app.register(hypdriv, { config })`); `app.hypdriv` gives `{ handler, manifest(), warnings }` |
| `webRoute(handler)` | mounts a Web-standard `(Request) => Response` handler (`jobHandler`, `auth.handler`) as a route |
| `fastifyManifest(urls, options)`, `fastifyPattern(url)`, `routesFromTree(tree)` | the route manifest and the Fastify → Hypdriv path conversion |
| `payloadResponse`, `applyResponse` | the reply ↔ Web `Response` conversions the plugin uses |
| `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` | request helpers for code below the plugin |
| `request.hypdrivNonce` | the request's CSP nonce, for templates |

## License

MIT

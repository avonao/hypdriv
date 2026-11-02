# @hypdriv/express

Hypdriv for [Express 5](https://expressjs.com) on Node and Vercel Functions: the Drivetrain — the HTTPS upgrade, security headers, CSP with per-request nonces, rate limiting, the bot shield, geo, feature flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` — as one Express middleware.

Full guide: [`docs/guides/express.md`](../../docs/guides/express.md). Example: [`examples/express`](../../examples/express).

```ts
import { useHypDriv } from '@hypdriv/express';
import express from 'express';
import config from '../hypdriv.config';

const app = express();
useHypDriv(app, { config });   // first: Express runs middleware in registration order
app.get('/', (req, res) => res.send('hello'));
app.listen(3000);
```

What the app writes is captured as a streaming Web `Response`, runs through the pipeline's later stages and goes out on the socket; request bodies stay with the app (body parsers read them as usual, even after a stage inspected a form field). Register `compression()` **before** `useHypDriv()`.

## Exports

| Export | Purpose |
| --- | --- |
| `useHypDriv(app, options)` | registers the middleware and derives the route manifest from the app's router stack |
| `hypdriv(options)` | the middleware alone (`app.use(hypdriv({ config }))`) |
| `webHandler(handler)` | mounts a Web-standard `(Request) => Response` handler (`jobHandler`, `auth.handler`) as a route |
| `expressManifest(app, options)`, `expressRoutes(app)`, `expressPattern(path)` | the route manifest and the Express → Hypdriv path conversion |
| `expressFetch(app, request)` | runs a Web `Request` through an Express app without a socket (revalidation, tests) |
| `checkOrder(app, middleware)` | what in the registration order defeats the Drivetrain |
| `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer`, `jobHandler` | request helpers for code below the middleware |
| `HypDrivExpressLocals` | `res.locals.hypdrivNonce` |

## License

MIT

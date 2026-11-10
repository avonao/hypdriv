# Hypdriv + Express

An [Express 5](https://expressjs.com) app behind the Hypdriv Drivetrain on Node, Vercel Functions and Cloudflare Workers: security headers, a CSP with a per-request nonce, rate limiting (`/api/**`), the bot shield, geo, flags, Early Hints, logs, `Server-Timing` and `/_hypdriv/*`.

```ts
// src/app.ts
const app = express();
useHypDriv(app, { config }); // before the routes: Express runs middleware in registration order
```

## Run it

```sh
pnpm start            # Node on http://localhost:3000 (PORT overrides)
pnpm dev              # the same, restarting on changes
pnpm dev:cloudflare   # Cloudflare Workers locally (wrangler dev, workerd)
pnpm hypdriv:audit    # headers, CSP and cache audit against http://localhost:3000
```

| Platform | Entry | Notes |
| --- | --- | --- |
| Node | `src/server.ts` | Mounts `app` below `compression()` (registered first, so it compresses the finished response) and serves `public/` with `express.static`. |
| Vercel | `export default app` from `src/app.ts` | Zero-config Express picks `src/app.ts` (it imports `express` and exports the app). Vercel serves `public/**` from its CDN and compresses at the edge. |
| Cloudflare | `src/worker.ts` (`wrangler.jsonc`) | `httpServerHandler()` from `cloudflare:node` (`nodejs_compat`) hands requests to the app's `listen()` server; the Durable Objects back the exact rate limiter, the tag index and live channels. No `compression()`: the request the Worker sees advertises `br, gzip` even when the client sent no `Accept-Encoding` (observed under `wrangler dev`), so a client that cannot decode Brotli would get it; Cloudflare compresses at the edge. |

Relative imports carry `.js` (`./app.js`): Vercel compiles each file to ESM without rewriting import specifiers, and Node's ESM loader needs the extension. `tsx` and `wrangler` map `.js` to the `.ts` source.

The routes show what the middleware preserves: a streamed response (`/stream`, every chunk is written as it is produced), a page whose inline script carries the request's CSP nonce (`/`), a content-hashed asset cached for a year (`/assets/styles.<hash>.css`), and request facts below the middleware (`/api/request`).

Guide: [`docs/guides/express.md`](https://github.com/avonao/hypdriv/blob/main/docs/guides/express.md).

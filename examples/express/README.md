# Hypdriv + Express

An [Express 5](https://expressjs.com) app behind the Hypdriv Drivetrain on Node and Vercel Functions: security headers, a CSP with a per-request nonce, rate limiting (`/api/**`), the bot shield, geo, flags, Early Hints, logs, `Server-Timing` and `/_hypdriv/*`.

```ts
// src/app.ts
const app = express();
app.use(compression()); // before Hypdriv: it then compresses the finished response
useHypDriv(app, { config }); // before the routes: Express runs middleware in registration order
```

## Run it

```sh
pnpm start          # Node on http://localhost:3000 (PORT overrides)
pnpm dev            # the same, restarting on changes
pnpm hypdriv:audit  # headers, CSP and cache audit against http://localhost:3000
```

On Node the entry is `src/server.ts`; on Vercel `export default app` from `src/app.ts` runs as a single Function (zero-config: Vercel finds `src/app.ts`, which imports `express` and exports the app). Vercel serves `public/**` from its CDN and ignores `express.static`.

The routes show what the middleware preserves: a streamed response (`/stream`, every chunk is written as it is produced), a page whose inline script carries the request's CSP nonce (`/`), a content-hashed asset cached for a year (`/assets/styles.<hash>.css`), and request facts below the middleware (`/api/request`).

Guide: [`docs/guides/express.md`](https://github.com/avonao/hypdriv/blob/main/docs/guides/express.md).

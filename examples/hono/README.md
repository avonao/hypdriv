# Hypdriv + Hono

A [Hono](https://hono.dev) app behind the Hypdriv Drivetrain on Cloudflare Workers, Vercel and Node: security headers, a CSP with a per-request nonce, rate limiting (`/api/**`), the bot shield, geo, flags, Early Hints, logs, `Server-Timing` and `/_hypdriv/*`.

```ts
// src/app.tsx
const app = new Hono<{ Variables: HypDrivHonoVariables }>();
useHypDriv(app, { config }); // first: Hono middleware only wraps the routes registered after it
```

## Run it

```sh
pnpm dev            # Cloudflare Workers locally (wrangler dev, workerd)
pnpm start          # Node (@hono/node-server) on http://localhost:3000
pnpm hypdriv:audit  # headers, CSP and cache audit against http://localhost:3000
```

On Cloudflare the entry is `src/index.ts` (the app plus Hypdriv's Durable Objects); on Node it is `src/server.ts`; on Vercel `export default app` from `src/index.ts` runs as a Function.

Guide: [`docs/guides/hono.md`](https://github.com/avonao/hypdriv/blob/main/docs/guides/hono.md).

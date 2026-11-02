# Hypdriv + Fastify

A [Fastify 5](https://fastify.dev) app behind the Hypdriv Drivetrain on Node and Vercel Functions: security headers, a CSP with a per-request nonce, rate limiting (`/api/**`), the bot shield, geo, flags, Early Hints, logs, `Server-Timing` and `/_hypdriv/*`.

```ts
// src/app.ts
const app = Fastify();
app.register(hypdriv, { config }); // the hooks cover every route, in every plugin context
app.register(fastifyCompress); // after Hypdriv: it then compresses the finished response
```

## Run it

```sh
pnpm start          # Node on http://localhost:3000 (PORT and HOST override)
pnpm dev            # the same, restarting on changes
pnpm hypdriv:audit  # headers, CSP and cache audit against http://localhost:3000
```

On Node the entry is `src/server.ts`; on Vercel `export default app` from `src/app.ts` runs as a single Function. Vercel serves `public/**` from its CDN and ignores `@fastify/static`.

The routes show what the plugin preserves: a streamed response (`/stream`, every chunk is written as it is produced), a page whose inline script carries the request's CSP nonce (`/`), a content-hashed asset cached for a year (`/assets/styles.<hash>.css`), and request facts below the plugin (`/api/request`).

Guide: [`docs/guides/fastify.md`](https://github.com/avonao/hypdriv/blob/main/docs/guides/fastify.md).

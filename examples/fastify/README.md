# Hypdriv + Fastify

A [Fastify 5](https://fastify.dev) app behind the Hypdriv Drivetrain on Node and Vercel Functions: security headers, a CSP with a per-request nonce, rate limiting (`/api/**`), the bot shield, geo, flags, Early Hints, logs, `Server-Timing` and `/_hypdriv/*`.

```ts
// src/server.ts
const app = Fastify();
app.register(hypdriv, { config }); // the hooks cover every route, in every plugin context
app.register(fastifyCompress); // after Hypdriv: it then compresses the finished response
app.register(routes);
app.listen({ port });
```

## Run it

```sh
pnpm start          # Node on http://localhost:3000 (PORT and HOST override)
pnpm dev            # the same, restarting on changes
pnpm hypdriv:audit  # headers, CSP and cache audit against http://localhost:3000
```

`src/server.ts` is the entry on both platforms. On Vercel, zero-config Fastify picks it (the first of `app`, `index`, `server` under the root or `src/` that imports `fastify`) and takes over the server `listen()` starts, so `listen()` is not awaited at the top level. Vercel's Fastify preset does not publish `public/**` to the CDN: `@fastify/static` serves it from the Function, whose file tracer follows `new URL('../public/', import.meta.url)`. Compression is registered on Node only; Vercel compresses at the edge.

Relative imports carry `.js` (`./routes.js`): Vercel compiles each file to ESM without rewriting import specifiers, and Node's ESM loader needs the extension.

Fastify does not run on Cloudflare Workers: its router compiles handlers with `new Function()`, which workerd refuses ("Code generation from strings disallowed"). Use `@hypdriv/hono` there.

The routes (`src/routes.ts`) show what the plugin preserves: a streamed response (`/stream`), a page whose inline script carries the request's CSP nonce (`/`), a content-hashed asset cached for a year (`/assets/styles.<hash>.css`), and request facts below the plugin (`/api/request`).

Guide: [`docs/guides/fastify.md`](https://github.com/avonao/hypdriv/blob/main/docs/guides/fastify.md).

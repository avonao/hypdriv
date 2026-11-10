// The entry on Node (`pnpm start`, or `tsx watch src/server.ts` as `pnpm dev`) and on Vercel (zero-config Fastify:
// the Function takes over the server that `listen()` starts).
import { fileURLToPath } from 'node:url';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { hypdriv } from '@hypdriv/fastify';
import Fastify from 'fastify';
import config from '../hypdriv.config.js';
import { routes } from './routes.js';

const app = Fastify();

// Hypdriv's request stages around every route, in every plugin context: security headers, the CSP nonce, rate
// limits (`/api/**`), the bot shield, Early Hints, logs and `/_hypdriv/*`. Fastify queues plugins until the app is
// ready, so there is nothing to await here.
app.register(hypdriv, { config });

// Compression after Hypdriv: its `onSend` hook then compresses the finished response (nonce already in the HTML).
// Node only: Vercel's CDN compresses Function responses itself.
if (process.env.VERCEL !== '1') app.register(fastifyCompress);

// Static files on every platform: Vercel's Fastify preset does not publish `public/**` to its CDN, so the Function
// serves them (Vercel's file tracer follows the `new URL(…, import.meta.url)` below).
app.register(fastifyStatic, { root: fileURLToPath(new URL('../public/', import.meta.url)), maxAge: '1h' });

app.register(routes);

// Not awaited: on Vercel the runtime captures the server in `listen()` and starts it only after this module has
// loaded, so a top-level `await` here would never finish.
const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: process.env.HOST ?? '0.0.0.0' }).then(
  (address) => console.log(`hypdriv-fastify listening on ${address}`),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);

// Finish in-flight responses before a deploy replaces the process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());

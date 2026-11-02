// The Node entry: `pnpm start` (or `tsx watch src/server.ts` as `pnpm dev`).
import app from './app';

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`hypdriv-fastify listening on http://localhost:${port}`);

// Finish in-flight responses before a deploy replaces the process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());

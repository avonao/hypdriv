// The Node entry: `pnpm start` (or `tsx watch src/server.ts` as `pnpm dev`).
import app from './app';

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`hypdriv-express listening on http://localhost:${port}`);
});

// Finish in-flight responses before a deploy replaces the process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());

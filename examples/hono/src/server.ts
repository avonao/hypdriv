// The Node entry: `pnpm start` (or `tsx watch src/server.ts` as `pnpm dev:node`).
import { serve } from '@hono/node-server';
import app from './app';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`hypdriv-hono listening on http://localhost:${info.port}`);
});

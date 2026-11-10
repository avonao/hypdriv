// The Node entry: `pnpm start` (or `tsx watch src/server.ts` as `pnpm dev`).
import { join } from 'node:path';
import compression from 'compression';
import express from 'express';
import app from './app.js';

const server = express();

// Compression wraps the app, so it compresses the finished response (with the CSP nonce already in the HTML).
// Register it before Hypdriv's middleware, which sits inside `app`. Vercel and Cloudflare compress at the edge.
server.use(compression());
server.use(app);

// Static files: Node serves `public/` itself; Vercel serves `public/**` from its CDN.
server.use(express.static(join(import.meta.dirname, '..', 'public'), { maxAge: '1h' }));

const port = Number(process.env.PORT ?? 3000);
const listener = server.listen(port, () => {
  console.log(`hypdriv-express listening on http://localhost:${port}`);
});

// Finish in-flight responses before a deploy replaces the process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => listener.close());

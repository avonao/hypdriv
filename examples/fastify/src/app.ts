import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { flag, geo, hyp, hypdriv, nonce } from '@hypdriv/fastify';
import Fastify from 'fastify';
import config from '../hypdriv.config';
import { stylesheet } from './assets';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The app behind Hypdriv: this module runs on Node (`src/server.ts`) and as a Vercel Function (`export default`). */
const app = Fastify();

// Hypdriv's request stages around every route, in every plugin context: security headers, the CSP nonce, rate
// limits (`/api/**`), the bot shield, Early Hints, logs and `/_hypdriv/*`. Fastify queues plugins until the app is
// ready, so there is nothing to await here.
app.register(hypdriv, { config });

// Compression after Hypdriv: its `onSend` hook then compresses the finished response (CSP nonce already in the HTML).
app.register(fastifyCompress);

// Static files (Node: Vercel serves `public/**` from its CDN and ignores @fastify/static).
app.register(fastifyStatic, { root: fileURLToPath(new URL('../public', import.meta.url)), maxAge: '1h' });

// A content-hashed asset: its URL changes with its content, so it is cached for a year.
app.get(stylesheet.path, async (_request, reply) =>
  reply.type('text/css').header('cache-control', 'public, max-age=31536000, immutable').send(stylesheet.css),
);

app.get('/', async (request, reply) =>
  reply.type('text/html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hypdriv + Fastify</title>
    <link rel="stylesheet" href="${stylesheet.path}" />
    <script nonce="${escapeHtml(nonce() ?? '')}">document.documentElement.dataset.js = '1'</script>
  </head>
  <body>
    <h1>${flag('newHero', false) ? 'Fastify, hardened at the edge' : 'Fastify behind Hypdriv'}</h1>
    <p>
      Request <code>${escapeHtml(hyp()?.requestId ?? '')}</code> from <code>${escapeHtml(geo()?.country ?? 'unknown')}</code>, CSP nonce
      <code>${request.hypdrivNonce ? 'set' : 'not set'}</code>.
    </p>
    <p>
      <a href="/api/time">/api/time</a> · <a href="/api/request">/api/request</a> ·
      <a href="/stream">/stream</a> · <a href="/_hypdriv/health">/_hypdriv/health</a>
    </p>
  </body>
</html>`),
);

app.get('/api/time', async () => ({ now: new Date().toISOString() }));

app.get('/api/request', async (request) => {
  const ctx = hyp();
  return {
    requestId: ctx?.requestId ?? null,
    runner: ctx?.runner ?? null,
    route: ctx?.route ?? null,
    country: ctx?.country ?? null,
    nonce: Boolean(request.hypdrivNonce),
  };
});

// A streamed response: each chunk reaches the client as it is produced.
app.get('/stream', async (_request, reply) => {
  async function* chunks() {
    for (let i = 1; i <= 3; i++) {
      yield `chunk ${i}\n`;
      await sleep(200);
    }
    yield 'done\n';
  }
  return reply.type('text/plain').send(Readable.from(chunks()));
});

export default app;

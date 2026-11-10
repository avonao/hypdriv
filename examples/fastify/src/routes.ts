import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { flag, geo, hyp, nonce } from '@hypdriv/fastify';
import type { FastifyInstance } from 'fastify';
import { stylesheet } from './assets.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The app's routes: a plugin `src/server.ts` registers after Hypdriv's, whose hooks reach every context. */
export async function routes(app: FastifyInstance) {
  // A content-hashed asset: its URL changes with its content, so it is cached for a year.
  app.get(stylesheet.path, async (_request, reply) =>
    reply
      .type('text/css')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(stylesheet.css),
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
}

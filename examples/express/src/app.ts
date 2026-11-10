import { flag, geo, hyp, nonce, useHypDriv } from '@hypdriv/express';
import express from 'express';
import config from '../hypdriv.config.js';
import { stylesheet } from './assets.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The app behind Hypdriv. One module for every platform: Node (`src/server.ts` adds compression and static files),
 * a Vercel Function (`export default`) and a Cloudflare Worker (`src/worker.ts`).
 */
const app = express();

// Hypdriv's request stages around everything below: security headers, the CSP nonce, rate limits (`/api/**`),
// the bot shield, Early Hints, logs and `/_hypdriv/*`. Register it before the routes and routers: Express runs
// middleware in registration order.
useHypDriv(app, { config });

// A content-hashed asset: its URL changes with its content, so it is cached for a year.
app.get(stylesheet.path, (_req, res) => {
  res.type('css').set('cache-control', 'public, max-age=31536000, immutable').send(stylesheet.css);
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hypdriv + Express</title>
    <link rel="stylesheet" href="${stylesheet.path}" />
    <script nonce="${escapeHtml(nonce() ?? '')}">document.documentElement.dataset.js = '1'</script>
  </head>
  <body>
    <h1>${flag('newHero', false) ? 'Express, hardened at the edge' : 'Express behind Hypdriv'}</h1>
    <p>
      Request <code>${escapeHtml(hyp()?.requestId ?? '')}</code> from <code>${escapeHtml(geo()?.country ?? 'unknown')}</code>, CSP nonce
      <code>${res.locals.hypdrivNonce ? 'set' : 'not set'}</code>.
    </p>
    <p>
      <a href="/api/time">/api/time</a> · <a href="/api/request">/api/request</a> ·
      <a href="/stream">/stream</a> · <a href="/_hypdriv/health">/_hypdriv/health</a>
    </p>
  </body>
</html>`);
});

app.get('/api/time', (_req, res) => {
  res.json({ now: new Date().toISOString() });
});

app.get('/api/request', (_req, res) => {
  const ctx = hyp();
  res.json({
    requestId: ctx?.requestId ?? null,
    runner: ctx?.runner ?? null,
    route: ctx?.route ?? null,
    country: ctx?.country ?? null,
    nonce: Boolean(res.locals.hypdrivNonce),
  });
});

// A streamed response: each chunk reaches the client as it is written.
app.get('/stream', async (_req, res) => {
  res.type('text/plain');
  for (let i = 1; i <= 3; i++) {
    res.write(`chunk ${i}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  res.end('done\n');
});

export default app;

import { flag, geo, type HypDrivHonoVariables, hyp, nonce, useHypDriv } from '@hypdriv/hono';
import { Hono } from 'hono';
import { html } from 'hono/html';
import config from '../hypdriv.config.js';

/** The app behind Hypdriv: the same module runs on Workers, Vercel Functions and Node. */
const app = new Hono<{ Variables: HypDrivHonoVariables }>();

// Hypdriv's request stages around everything below: security headers, the CSP nonce, rate limits (`/api/**`),
// the bot shield, Early Hints, logs and `/_hypdriv/*`. Register it first: Hono middleware only wraps the routes
// registered after it.
useHypDriv(app, { config });

app.get('/', (c) =>
  c.html(
    html`<!doctype html>${(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Hypdriv + Hono</title>
          <script nonce={nonce()}>{'document.documentElement.dataset.js = "1"'}</script>
        </head>
        <body>
          <h1>{flag('newHero', false) ? 'Hono, hardened at the edge' : 'Hono behind Hypdriv'}</h1>
          <p>
            Request <code>{hyp()?.requestId}</code> from <code>{geo()?.country ?? 'unknown'}</code>, CSP nonce{' '}
            <code>{c.get('hypdrivNonce') ? 'set' : 'not set'}</code>.
          </p>
          <p>
            <a href="/api/time">/api/time</a> · <a href="/api/request">/api/request</a> ·{' '}
            <a href="/_hypdriv/health">/_hypdriv/health</a>
          </p>
        </body>
      </html>
    )}`,
  ),
);

app.get('/api/time', (c) => c.json({ now: new Date().toISOString() }));

app.get('/api/request', (c) => {
  const ctx = hyp();
  return c.json({
    requestId: ctx?.requestId ?? null,
    runner: ctx?.runner ?? null,
    route: ctx?.route ?? null,
    country: ctx?.country ?? null,
    nonce: Boolean(c.get('hypdrivNonce')),
  });
});

export default app;

/**
 * Worker used by the workerd tests (`vitest.workers.config.ts` → `main`). It is shaped exactly like an
 * application's `hypdriv.worker.ts`: Durable Objects re-exported, `createWorker` around a Next.js stand-in.
 */
import { emptyManifest, routePatternToRegex } from '@hypdriv/core';
import { createWorker } from '../worker';

export { HypDrivIndex, HypDrivLimiter } from '../durable-objects/index';

const manifest = emptyManifest({
  buildId: 'workers-test',
  routes: [
    {
      id: 'app:/',
      pathname: '/',
      regex: routePatternToRegex('/'),
      kind: 'app-page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
    {
      id: 'route:/api/ping',
      pathname: '/api/ping',
      regex: routePatternToRegex('/api/ping'),
      kind: 'app-route',
      classification: 'route',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
});

const html = `<!doctype html><html><head><title>t</title></head><body>
  <!-- a developer comment -->
  <!--$--><main>    <img src="/hero.jpg" loading="lazy" class="hero"><pre>  keep   this  </pre></main><!--/$-->
</body></html>`;

export default createWorker({
  config: {
    site: { name: 'workers-test' },
    performance: {
      html: { stripComments: true, collapseWhitespace: true },
      priorityHints: { selectors: ['img.hero'] },
    },
    security: {
      rateLimit: [{ id: 'api', match: '/api/**', limit: 3, window: '1m', algorithm: 'fixed-window' }],
    },
  },
  manifest,
  development: false,
  next: async () => ({
    default: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === '/api/ping') return Response.json({ pong: true });
        if (url.pathname === '/ws') {
          // A WebSocket endpoint, as a Hono `upgradeWebSocket()` or a Next.js custom route answers it.
          const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
          server.accept();
          server.addEventListener('message', (event) => server.send(`echo:${String(event.data)}`));
          return new Response(null, { status: 101, webSocket: client });
        }
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    },
  }),
});

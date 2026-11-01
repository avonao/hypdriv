import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/solid-start/vite';
import { solidStart } from '@solidjs/start/config';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// One app, three targets: Cloudflare Workers (`@cloudflare/vite-plugin`, Hypdriv's Worker shell in src/worker.ts),
// Vercel and Node (Nitro). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default defineConfig({
  plugins: [
    solidStart(),
    ...(target === 'cloudflare'
      ? [
          // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
          cloudflare({
            viteEnvironment: { name: 'ssr' },
            ...(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {}),
          }),
        ]
      : [nitro({ preset: target === 'vercel' ? 'vercel' : 'node-server' })]),
    // After solidStart() and the deployment plugin: finalises the manifest once Nitro has prerendered.
    hypdriv(),
  ],
  // Cloudflare development runs the server in workerd, whose dependency optimiser would otherwise find Solid on the
  // first request and reload the Worker under it (that first render fails); pre-bundling it up front avoids that.
  ...(target === 'cloudflare'
    ? {
        environments: {
          ssr: {
            optimizeDeps: {
              include: [
                'solid-js',
                'solid-js/web',
                'solid-js/store',
                '@solidjs/router',
                '@solidjs/start/fns/server',
              ],
            },
          },
        },
      }
    : {}),
  // SolidStart's only static generation is Nitro's prerendering (Node and Vercel): these two pages are built as
  // files, served with a hash-based Content-Security-Policy. On Cloudflare every page renders per request.
  nitro: { prerender: { routes: ['/', '/about'] } },
});

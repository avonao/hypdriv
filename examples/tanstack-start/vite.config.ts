import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv, withHypDriv } from '@hypdriv/tanstack-start/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// One app, three targets: Cloudflare Workers (`@cloudflare/vite-plugin`, Hypdriv's Worker shell in src/worker.ts),
// Vercel and Node (Nitro). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default defineConfig({
  plugins: [
    // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
    ...(target === 'cloudflare'
      ? [
          cloudflare({
            viteEnvironment: { name: 'ssr' },
            ...(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {}),
          }),
        ]
      : []),
    tanstackStart(
      // withHypDriv() marks Start's prerender requests (so the pipeline stays out of the static HTML) and writes
      // prerendered pages as `about.html`, the path Start's router and the platforms serve without a redirect.
      withHypDriv({
        prerender: { enabled: true, autoStaticPathsDiscovery: false, crawlLinks: false },
        pages: [{ path: '/' }, { path: '/about' }],
      }),
    ),
    ...(target === 'cloudflare' ? [] : [nitro({ preset: target === 'vercel' ? 'vercel' : 'node-server' })]),
    viteReact(),
    // After tanstackStart() and nitro(): finalises the manifest once prerendering is done.
    hypdriv(),
  ],
});

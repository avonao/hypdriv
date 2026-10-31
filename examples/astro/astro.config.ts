import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';
import hypdriv from '@hypdriv/astro';
import { defineConfig } from 'astro/config';

// One app, three targets: Cloudflare (HypDriv's Worker shell in front of Astro and the static assets), Vercel
// (the function runs the middleware; prerendered pages get HypDriv's header routes) and Node (`@astrojs/node`
// standalone; prerendered pages get HypDriv's `_headers.json`). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

const adapter =
  target === 'vercel'
    ? vercel()
    : target === 'node'
      ? node({ mode: 'standalone', staticHeaders: true })
      : cloudflare();

export default defineConfig({
  output: 'server',
  adapter,
  integrations: [hypdriv()],
});

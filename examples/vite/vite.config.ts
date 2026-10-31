import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/vite';
import { defineConfig } from 'vite';

// One app, three targets: Cloudflare (a Worker in front of the static assets), Vercel (Build Output with HypDriv's
// Routing Middleware) and Node (`hypdriv serve`). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default defineConfig({
  plugins: [
    ...(target === 'cloudflare' ? [cloudflare()] : []),
    hypdriv({ targets: [target as 'cloudflare'] }),
  ],
});

import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/vite';
import { defineConfig } from 'vite';

// One app, three targets: Cloudflare (a Worker in front of the static assets), Vercel (Build Output with Hypdriv's
// Routing Middleware) and Node (`hypdriv serve`). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default defineConfig({
  plugins: [
    // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
    ...(target === 'cloudflare'
      ? [cloudflare(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {})]
      : []),
    hypdriv({ targets: [target as 'cloudflare'] }),
  ],
});

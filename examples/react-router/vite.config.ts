import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/react-router';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default defineConfig({
  plugins: [
    // Cloudflare: React Router's server environment is the Worker (`workers/app.ts`).
    // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
    ...(target === 'cloudflare'
      ? [
          cloudflare({
            viteEnvironment: { name: 'ssr' },
            ...(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {}),
          }),
        ]
      : []),
    hypdriv({ target: target as 'cloudflare' | 'vercel' | 'node' }),
    reactRouter(),
  ],
});

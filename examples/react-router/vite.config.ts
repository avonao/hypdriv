import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/react-router';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default defineConfig({
  plugins: [
    // Cloudflare: React Router's server environment is the Worker (`workers/app.ts`).
    ...(target === 'cloudflare' ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    hypdriv({ target: target as 'cloudflare' | 'vercel' | 'node' }),
    reactRouter(),
  ],
});

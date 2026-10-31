import { hypdriv } from '@hypdriv/sveltekit';
import cloudflare from '@sveltejs/adapter-cloudflare';
import node from '@sveltejs/adapter-node';
import vercel from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// One app, three targets: Cloudflare Workers (adapter-cloudflare behind HypDriv's Worker shell), Vercel
// (adapter-vercel's Build Output with HypDriv's header routes) and Node (adapter-node behind `@hypdriv/sveltekit/node`).
// Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');
const adapter = target === 'vercel' ? vercel() : target === 'node' ? node() : cloudflare();

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: hypdriv(adapter),
      // SvelteKit's own policy: HypDriv folds these directives into its per-request policy (one header, HypDriv's
      // nonce) and keeps the hashes of the <meta> policy SvelteKit writes into prerendered pages.
      csp: { mode: 'auto', directives: { 'script-src': ['self'], 'object-src': ['none'] } },
    }),
  ],
});

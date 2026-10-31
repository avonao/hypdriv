import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';
import hypdriv from '@hypdriv/astro';
import { defineConfig } from 'astro/config';

// One app, three targets: Cloudflare (Hypdriv's Worker shell in front of Astro and the static assets), Vercel
// (the function runs the middleware; prerendered pages get Hypdriv's header routes) and Node (`@astrojs/node`
// standalone; prerendered pages get Hypdriv's `_headers.json`). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

const adapter =
  target === 'vercel'
    ? vercel()
    : target === 'node'
      ? node({ mode: 'standalone', staticHeaders: true })
      : // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
        cloudflare(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {});

export default defineConfig({
  output: 'server',
  adapter,
  integrations: [hypdriv()],
  // Stylesheets as content-hashed files under /_astro/ (immutable caching from Hypdriv's static rules) instead of
  // inline <style> blocks.
  build: { inlineStylesheets: 'never' },
});

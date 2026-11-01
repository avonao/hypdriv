// One app, three targets: Cloudflare Workers (Hypdriv's Worker entry around Nitro), Vercel (Build Output) and Node
// (`node dist/analog/server/index.mjs`). Vercel builds set VERCEL=1.
import { readFileSync } from 'node:fs';
import analog from '@analogjs/platform';
import { hypdriv, withHypDriv } from '@hypdriv/analog';
import { defineConfig } from 'vite';

const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');
const presets: Record<string, string> = {
  cloudflare: 'cloudflare-module',
  vercel: 'vercel',
  node: 'node-server',
};

// WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc (written by
// `e2e/hosts provision`). Nitro merges `cloudflare.wrangler` into wrangler.jsonc (arrays are concatenated), so only
// the deployment's own keys are taken from it.
const ACCOUNT_KEYS = ['name', 'routes', 'workers_dev', 'preview_urls', 'observability', 'vars'];
const accountWrangler = process.env.WRANGLER_CONFIG
  ? Object.fromEntries(
      Object.entries(
        JSON.parse(readFileSync(process.env.WRANGLER_CONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, '')) as Record<
          string,
          unknown
        >,
      ).filter(([key]) => ACCOUNT_KEYS.includes(key)),
    )
  : null;

export default defineConfig({
  build: { target: ['es2022'] },
  resolve: { mainFields: ['module'] },
  plugins: [
    analog(
      // `withHypDriv` adds the Hypdriv Nitro module to `nitro.modules`; `hypdriv.config.ts` holds the Hypdriv config.
      withHypDriv({
        ssr: true,
        // Prerendered at build time: served by Workers Static Assets / the Vercel CDN with hash-based CSP.
        // Every other page (`/ssr`, `/blog/[slug]`) is rendered per request with a nonce.
        prerender: { routes: ['/', '/about'] },
        nitro: {
          preset: presets[target] ?? target,
          compatibilityDate: '2026-10-01',
          // Cloudflare: write `dist/analog/server/wrangler.json` from `wrangler.jsonc` (Durable Objects, flags).
          ...(target === 'cloudflare'
            ? { cloudflare: { deployConfig: true, ...(accountWrangler ? { wrangler: accountWrangler } : {}) } }
            : {}),
        },
      }),
    ),
    hypdriv(),
  ],
});

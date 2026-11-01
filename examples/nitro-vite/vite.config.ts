// Nitro 3 on Vite: `nitro()` adds the server, `hypdriv()` registers the Hypdriv module with it. One app, three targets:
// Cloudflare Workers (Hypdriv's Worker entry around Nitro), Vercel (Build Output) and Node
// (`node .output/server/index.mjs`). Vercel builds set VERCEL=1.
import { readFileSync } from 'node:fs';
import { hypdriv } from '@hypdriv/nitro/vite';
import { nitro } from 'nitro/vite';
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
  plugins: [
    nitro({
      compatibilityDate: '2026-10-01',
      serverDir: 'server',
      preset: presets[target] ?? target,
      routeRules: {
        // Prerendered at build time: served by Workers Static Assets / the Vercel CDN with hash-based CSP.
        '/': { prerender: true },
        '/about': { prerender: true },
      },
      // `server/public` (favicon…) is served from `/`; the content-hashed files in `server/static` from `/assets/`,
      // `cache-control: public, max-age=31536000, immutable`.
      publicAssets: [{ baseURL: '/assets', dir: 'server/static', maxAge: 60 * 60 * 24 * 365 }],
      // Cloudflare: write `.output/server/wrangler.json` from `wrangler.jsonc` (Durable Objects, flags).
      ...(target === 'cloudflare'
        ? { cloudflare: { deployConfig: true, ...(accountWrangler ? { wrangler: accountWrangler } : {}) } }
        : {}),
    }),
    // `hypdriv.config.ts` holds the Hypdriv config itself; the plugin's options are all optional.
    hypdriv(),
  ],
});

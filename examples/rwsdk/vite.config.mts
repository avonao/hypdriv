import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/rwsdk';
import { redwood } from 'rwsdk/vite';
import { defineConfig } from 'vite';

// RedwoodSDK builds the Worker in the `worker` environment of @cloudflare/vite-plugin. Declaring the plugin here
// (instead of letting redwood() add its own) gives the Worker one Wrangler config, which WRANGLER_CONFIG can point
// at an account-specific, git-ignored wrangler.<name>.local.jsonc. `hypdriv()` goes last: it finalises the manifest
// after RedwoodSDK's multi-pass build.
export default defineConfig({
  environments: { ssr: {} },
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'worker' },
      ...(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {}),
    }),
    redwood(),
    hypdriv(),
  ],
});

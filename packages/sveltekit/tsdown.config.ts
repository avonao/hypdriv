import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    hooks: 'src/hooks.ts',
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    'durable-objects': 'src/durable-objects.ts',
    node: 'src/node/index.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, SvelteKit, Vite, SvelteKit's `$app/*` modules and Hypdriv's virtual modules stay external:
  // the hooks entry is bundled into the application's server build, where Vite resolves them.
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^@sveltejs\//,
      /^svelte(\/|$)/,
      /^vite$/,
      /^wrangler$/,
      /^\$app\//,
      /^virtual:hypdriv\//,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  inputOptions: { optimization: { inlineConst: false } },
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});

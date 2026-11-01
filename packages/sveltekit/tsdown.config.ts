import { defineConfig } from 'tsdown';

const shared = {
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
  treeshake: true,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      hooks: 'src/hooks.ts',
      server: 'src/server.ts',
      worker: 'src/worker.ts',
      node: 'src/node/index.ts',
    },
    clean: true,
    inputOptions: { optimization: { inlineConst: false } },
    define: {
      __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    },
  },
  {
    // The Durable Object re-export is typed against the Workers sources it re-exports, so it is built from its own
    // program (tsconfig.durable-objects.json adds the Workers types); TypeScript 7 emits declarations only for files
    // that belong to the tsconfig, which tsconfig.json deliberately keeps this one out of.
    ...shared,
    entry: { 'durable-objects': 'src/durable-objects.ts' },
    tsconfig: 'tsconfig.durable-objects.json',
    clean: false,
  },
]);

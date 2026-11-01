import { defineConfig } from 'tsdown';

const shared = {
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, Qwik, Vite and the virtual modules stay external: the middleware is bundled into the
  // application's server build by Qwik's Vite build (it imports `virtual:hypdriv/*`); the adapters and the plugin
  // run in Node during the build.
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^@qwik\.dev\//,
      /^@qwik-router-config$/,
      /^vite$/,
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
      server: 'src/server.ts',
      'adapters/node': 'src/adapters/node.ts',
      'adapters/vercel': 'src/adapters/vercel.ts',
      'adapters/cloudflare': 'src/adapters/cloudflare.ts',
      'middleware/node': 'src/middleware/node.ts',
      'middleware/vercel': 'src/middleware/vercel.ts',
      'middleware/cloudflare': 'src/middleware/cloudflare.ts',
    },
    clean: true,
    inputOptions: { optimization: { inlineConst: false } },
  },
  {
    // The Durable Object re-export is typed against the Workers sources it re-exports, so it is built from its own
    // program (tsconfig.durable-objects.json adds the Workers types); tsconfig.json keeps this file out.
    ...shared,
    entry: { 'durable-objects': 'src/durable-objects.ts' },
    tsconfig: 'tsconfig.durable-objects.json',
    clean: false,
  },
]);

import { defineConfig } from 'tsdown';

const shared = {
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, Waku, Vite and the virtual modules stay external: the adapters are bundled into the
  // application's server build by Waku's Vite build (they import `virtual:hypdriv/*`); the plugin runs in Node.
  deps: {
    neverBundle: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^waku(?:\/|$)/, /^vite$/, /^virtual:hypdriv\//],
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

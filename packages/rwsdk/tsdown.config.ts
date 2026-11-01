import { defineConfig } from 'tsdown';

const shared = {
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, rwsdk, Vite and the virtual modules stay external: `worker` and `wrap` are bundled into the
  // application's Worker by its Vite build (the Hypdriv plugin serves the `virtual:hypdriv/*` modules); the plugin
  // runs in Node.
  deps: {
    neverBundle: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^rwsdk(?:\/|$)/, /^vite$/, /^virtual:hypdriv\//],
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
      worker: 'src/worker.ts',
      wrap: 'src/wrap.ts',
      server: 'src/server.ts',
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

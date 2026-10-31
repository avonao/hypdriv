import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    runtime: 'src/runtime.ts',
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    proxy: 'src/proxy.ts',
    cache: 'src/cache.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, vinext, Vite and the virtual modules stay external.
  deps: {
    neverBundle: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^vinext(?:\/|$)/, /^vite$/, /^virtual:/],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

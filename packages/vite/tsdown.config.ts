import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
    node: 'src/node/index.ts',
    'vercel-middleware': 'src/vercel-middleware.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, Vite and the virtual modules stay external.
  deps: { neverBundle: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^vite$/, /^virtual:hypdriv\//] },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});

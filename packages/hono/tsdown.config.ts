import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  deps: { neverBundle: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^hono(\/|$)/] },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

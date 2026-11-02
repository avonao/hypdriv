import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  fixedExtension: false,
  target: 'es2023',
  deps: { neverBundle: [/^node:/, /^@hypdriv\//, /^fastify(\/|$)/, /^fastify-plugin(\/|$)/] },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
      'index': 'src/index.ts',
      'client': 'src/client/index.ts'
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  external: [/^node:/, /^cloudflare:/],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});

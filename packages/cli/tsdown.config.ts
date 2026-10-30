import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bin: 'src/bin.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  // package.json maps the bin and exports to `dist/*.js` (the package is `"type": "module"`).
  fixedExtension: false,
  external: [/^node:/, /^cloudflare:/],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});

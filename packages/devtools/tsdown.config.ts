import { defineConfig } from 'tsdown';
import { clientDirectivePlugin, quietClientDirective } from '../../scripts/tsdown-client-directive.mjs';

export default defineConfig({
  entry: {
    index: 'src/index.tsx',
  },
  format: ['esm'],
  platform: 'browser',
  target: 'es2023',
  deps: { neverBundle: [/^node:/, /^cloudflare:/] },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Client entries keep their 'use client' boundary (enforced, so rolldown's generic warning is noise).
  plugins: [clientDirectivePlugin()],
  inputOptions: { onLog: quietClientDirective },
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});

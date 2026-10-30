import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
      'index': 'src/index.ts',
      'config': 'src/config.ts',
      'next': 'src/next.ts',
      'cloudflare': 'src/cloudflare.ts',
      'server': 'src/server.ts',
      'client': 'src/client.tsx'
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

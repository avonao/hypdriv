import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    'entry-server': 'src/entry-server.ts',
    cloudflare: 'src/cloudflare.ts',
    node: 'src/node.ts',
    serve: 'src/serve.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, React Router, React, Vite and the virtual modules stay external.
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^react(?:-dom)?(?:\/|$)/,
      /^react-router(?:\/|$)/,
      /^@react-router\//,
      /^vite$/,
      /^virtual:/,
      /^isbot$/,
      /^@vercel\/nft$/,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});

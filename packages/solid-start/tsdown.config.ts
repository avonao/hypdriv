import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    'server-client': 'src/server-client.ts',
    nitro: 'src/nitro.ts',
    cloudflare: 'src/cloudflare.ts',
    vite: 'src/vite.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, SolidStart, Nitro, Vite and Hypdriv's virtual modules stay external: the Nitro plugin is
  // bundled into the server by Nitro and the Worker entry by Vite (both resolve the virtual modules); the Vite
  // plugin runs in Node.
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^@solidjs\//,
      /^solid-js(?:\/|$)/,
      /^nitro(?:\/|$)/,
      /^h3$/,
      /^vite$/,
      /^virtual:hypdriv\//,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

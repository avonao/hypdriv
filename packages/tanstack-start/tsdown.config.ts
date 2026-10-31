import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    server: 'src/server.ts',
    'server-client': 'src/server-client.ts',
    'server-entry': 'src/server-entry.ts',
    cloudflare: 'src/cloudflare.ts',
    vite: 'src/vite/index.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, the frameworks and Hypdriv's virtual modules stay external: the application's Vite build
  // resolves them (the virtual modules only exist there).
  deps: {
    neverBundle: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^@tanstack\//, /^vite$/, /^virtual:hypdriv\//],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

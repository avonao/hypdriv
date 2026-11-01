import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    vite: 'src/vite.ts',
    server: 'src/server.ts',
    // Runtime files the module registers with Nitro; they are bundled into the application's server.
    'runtime/nitro2/plugin': 'src/runtime/nitro2/plugin.ts',
    'runtime/nitro2/cloudflare-worker': 'src/runtime/nitro2/cloudflare-worker.ts',
    'runtime/nitro3/plugin': 'src/runtime/nitro3/plugin.ts',
    'runtime/nitro3/cloudflare-worker': 'src/runtime/nitro3/cloudflare-worker.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, Nitro (2 and 3), h3, Vite, Nitro's and Hypdriv's virtual modules stay external: Nitro
  // resolves them when it bundles the application.
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^nitropack(\/|$)/,
      /^nitro(\/|$)/,
      /^h3$/,
      /^vite$/,
      /^crossws(\/|$)/,
      /^#/,
      /^virtual:/,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

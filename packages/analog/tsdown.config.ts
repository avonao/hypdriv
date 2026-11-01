import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    angular: 'src/angular.ts',
    'angular-server': 'src/angular-server.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, Angular, Nitro, Vite and the Analog platform stay external.
  deps: {
    neverBundle: [
      /^node:/,
      /^@hypdriv\//,
      /^@angular\//,
      /^@analogjs\//,
      /^nitropack(\/|$)/,
      /^rxjs(\/|$)/,
      /^vite$/,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});

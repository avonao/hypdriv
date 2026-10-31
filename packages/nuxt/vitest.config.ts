import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fixture = (name: string) =>
  fileURLToPath(new URL(`./src/runtime/__fixtures__/${name}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    // The modules Nitro provides to the plugin when it bundles the application.
    alias: [
      { find: /^#hypdriv\/options$/, replacement: fixture('options') },
      { find: /^virtual:hypdriv\/config$/, replacement: fixture('config') },
      { find: /^virtual:hypdriv\/manifest$/, replacement: fixture('manifest') },
      { find: /^nitropack\/runtime$/, replacement: fixture('virtual') },
    ],
  },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'nuxt',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

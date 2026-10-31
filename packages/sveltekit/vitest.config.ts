import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fixture = (name: string) => fileURLToPath(new URL(`./src/__fixtures__/${name}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    // The hook imports SvelteKit's `$app/env` and Hypdriv's virtual modules, which only exist inside a SvelteKit
    // build: tests substitute fixtures.
    alias: {
      '$app/env': fixture('app-env'),
      'virtual:hypdriv/config': fixture('virtual-config'),
      'virtual:hypdriv/manifest': fixture('virtual-manifest'),
      'virtual:hypdriv/sveltekit': fixture('virtual-sveltekit'),
    },
  },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'sveltekit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

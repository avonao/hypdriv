import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist. `workerd` selects
  // RedwoodSDK's router (its default export condition is the browser's link helpers only).
  ssr: { resolve: { conditions: ['source', 'workerd'] } },
  test: {
    name: 'rwsdk',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    server: { deps: { inline: [/[\\/]rwsdk[\\/]/] } },
    // A real RedwoodSDK build of a fixture app runs in `build.test.ts`.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});

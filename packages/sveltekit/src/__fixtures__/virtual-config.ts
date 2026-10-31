// Test stand-in for `virtual:hypdriv/config` (aliased in vitest.config.ts).
import type { HypDrivConfig } from '@hypdriv/core';

const config: HypDrivConfig = {
  site: { name: 'sveltekit-fixture' },
  security: { csp: { directives: { 'img-src': ['https://img.example.com'] } } },
};

export default config;

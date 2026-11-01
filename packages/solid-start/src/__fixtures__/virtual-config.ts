import type { HypDrivConfig } from '@hypdriv/core';

// Stands in for `virtual:hypdriv/config` in tests.
const config: HypDrivConfig = {
  site: { name: 'fixture' },
  platform: 'node',
  security: { bots: { definitelyAutomated: 'block' } },
  flags: {
    definitions: { newHero: { default: false, rules: [{ when: { country: ['US'] }, value: true }] } },
  },
};

export default config;

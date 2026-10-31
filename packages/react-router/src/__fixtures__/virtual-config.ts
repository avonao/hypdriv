import type { HypDrivConfig } from '@hypdriv/core';

// Stand-in for `virtual:hypdriv/config` in tests.
const config: HypDrivConfig = {
  site: { name: 'rr-test' },
  security: {
    rateLimit: [{ id: 'login', match: '/login', limit: 1, window: '1m', key: ['ip'] }],
  },
  redirects: { rules: [{ from: '/old', to: '/new', status: 307 }] },
};

export default config;

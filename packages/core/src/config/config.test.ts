import { describe, expect, it } from 'vitest';
import { defineConfig, loadConfig } from './define';
import { isResolvedConfig, resolveConfig } from './resolve';
import { validateConfig } from './validate';

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    const r = resolveConfig({});
    expect(r.security.csp?.mode).toBe('auto');
    expect(r.security.headers?.hsts?.maxAge).toBe(63072000);
    expect(r.cache.edge?.inferredStatic.ttl).toBe(300);
    expect(r.cache.edge?.store).toBe('auto');
    expect(r.performance.earlyHints?.maxLinks).toBe(12);
    expect(r.performance.speculation?.prerender?.eagerness).toBe('moderate');
    expect(r.observe.serverTiming).toBe('auto');
    expect(r.purser?.enabled).toBe('auto');
    expect(r.flags.idCookie).toBe('hyp_uid');
    expect(r.cloudflare.internalPathPrefix).toBe('/_hypdriv');
    expect(r.devtools.enabled).toBe('development');
    expect(r.i18n).toBeNull();
  });

  it('keeps the vitals dashboard off unless asked, with defaults when on', () => {
    expect(resolveConfig({}).observe.vitals?.dashboard).toBeNull();
    expect(resolveConfig({ observe: { vitals: true } }).observe.vitals?.dashboard).toBeNull();
    expect(resolveConfig({ observe: { vitals: { dashboard: false } } }).observe.vitals?.dashboard).toBeNull();
    expect(resolveConfig({ observe: { vitals: false } }).observe.vitals).toBeNull();
    expect(resolveConfig({ observe: { vitals: { dashboard: true } } }).observe.vitals?.dashboard).toEqual({
      tokenEnv: 'HYPDRIV_DASH_TOKEN',
      accountIdEnv: 'HYPDRIV_ANALYTICS_ACCOUNT_ID',
      apiTokenEnv: 'HYPDRIV_ANALYTICS_API_TOKEN',
      dataset: null,
      datasetEnv: 'HYPDRIV_ANALYTICS_DATASET',
      days: 7,
      cacheSeconds: 60,
      sessionMinutes: 480,
      memoryCapacity: 5000,
    });
    expect(
      resolveConfig({
        observe: { vitals: { dashboard: { dataset: 'shop_vitals', days: 30, memoryCapacity: 0 } } },
      }).observe.vitals?.dashboard,
    ).toMatchObject({ dataset: 'shop_vitals', days: 30, memoryCapacity: 0, cacheSeconds: 60 });
  });

  it('parses durations and sizes', () => {
    const r = resolveConfig({
      cache: {
        edge: {
          policies: [{ match: '/blog/**', ttl: '5m', swr: '1h', staleIfError: '2d' }],
          maxBodySize: '2mb',
        },
      },
      security: { sessions: { ttl: '12h' }, shield: { maxBody: '512kb' } },
    });
    const p = r.cache.edge!.policies[0]!;
    expect(p.ttl).toBe(300);
    expect(p.swr).toBe(3600);
    expect(p.staleIfError).toBe(172800);
    expect(r.cache.edge!.maxBodySize).toBe(2_000_000);
    expect(r.security.sessions.ttlSeconds).toBe(43200);
    expect(r.security.shield!.maxBody[0]!.limit).toBe(512_000);
  });

  it('disables sections with false', () => {
    const r = resolveConfig({
      security: { csp: false, headers: false, bots: false },
      cache: { edge: false },
      purser: false,
      performance: { speculation: false },
    });
    expect(r.security.csp).toBeNull();
    expect(r.security.headers).toBeNull();
    expect(r.security.bots).toBeNull();
    expect(r.cache.edge).toBeNull();
    expect(r.purser).toBeNull();
    expect(r.performance.speculation).toBeNull();
  });

  it('merges permissions policy overrides over defaults', () => {
    const r = resolveConfig({ security: { headers: { permissionsPolicy: { camera: ['self'] } } } });
    expect(r.security.headers!.permissionsPolicy!.camera).toEqual(['self']);
    expect(r.security.headers!.permissionsPolicy!.geolocation).toEqual([]);
  });

  it('lowercases vary headers and bypass headers', () => {
    const r = resolveConfig({
      cache: {
        edge: {
          policies: [
            {
              match: '/x',
              ttl: 10,
              vary: { headers: ['Accept-Language'] },
              bypass: { headers: ['X-Preview'] },
            },
          ],
        },
      },
    });
    expect(r.cache.edge!.policies[0]!.vary.headers).toEqual(['accept-language']);
    expect(r.cache.edge!.policies[0]!.bypass.headers).toEqual(['x-preview']);
  });

  it("applies cache.edge.bypass to every explicit policy, merged with the policy's own", () => {
    const r = resolveConfig({
      cache: {
        edge: {
          bypass: { cookies: ['site_gate'], headers: ['X-Gate'], query: ['preview'] },
          policies: [
            { match: '/a', ttl: 10 },
            { match: '/b', ttl: 10, bypass: { cookies: ['session', 'site_gate'] } },
          ],
        },
      },
    });
    expect(r.cache.edge!.bypass).toEqual({ cookies: ['site_gate'], headers: ['x-gate'], query: ['preview'] });
    expect(r.cache.edge!.policies[0]!.bypass).toMatchObject({
      cookies: ['site_gate'],
      headers: ['x-gate'],
      query: ['preview'],
    });
    expect(r.cache.edge!.policies[1]!.bypass.cookies).toEqual(['session', 'site_gate']);
  });
});

describe('experiments in the cache policies', () => {
  const flags = {
    definitions: {
      checkout: { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
      hero: {
        default: 'a',
        experiment: { variants: { a: 1, b: 1 }, status: 'concluded' as const, winner: 'b' },
      },
      banner: { default: true },
    },
  };

  it('varies every explicit policy on the experiments that still assign variants', () => {
    const r = resolveConfig({
      flags,
      cache: {
        edge: {
          policies: [
            { match: '/a', ttl: 10 },
            { match: '/b', ttl: 10, vary: { flags: ['banner'] } },
            { match: '/api/**', ttl: 10, vary: { experiments: false } },
          ],
        },
      },
    });
    const [a, b, api] = r.cache.edge!.policies;
    expect(a!.vary.flags).toEqual(['checkout']);
    expect(a!.vary.experiments).toBe(true);
    expect(b!.vary.flags).toEqual(['banner', 'checkout']);
    expect(api!.vary.flags).toEqual([]);
    expect(api!.vary.experiments).toBe(false);
  });

  it('leaves policies alone without experiments', () => {
    const r = resolveConfig({ cache: { edge: { policies: [{ match: '/a', ttl: 10 }] } } });
    expect(r.cache.edge!.policies[0]!.vary.flags).toEqual([]);
  });
});

describe('cache.warm.hot', () => {
  it('is off unless asked for, and has defaults when on', () => {
    expect(resolveConfig({}).cache.warm.hot).toBeNull();
    expect(resolveConfig({ cache: { warm: { hot: false } } }).cache.warm.hot).toBeNull();
    expect(resolveConfig({ cache: { warm: { hot: true } } }).cache.warm.hot).toEqual({
      limit: 25,
      days: 7,
      minViews: 20,
      dataset: null,
      datasetEnv: 'HYPDRIV_ANALYTICS_DATASET',
      accountIdEnv: 'HYPDRIV_ANALYTICS_ACCOUNT_ID',
      apiTokenEnv: 'HYPDRIV_ANALYTICS_API_TOKEN',
    });
    expect(
      resolveConfig({ cache: { warm: { hot: { limit: 5, dataset: 'shop_vitals' } } } }).cache.warm.hot,
    ).toMatchObject({ limit: 5, days: 7, dataset: 'shop_vitals' });
  });

  it('validates the options', () => {
    expect(validateConfig({ cache: { warm: { hot: true } } }).filter((x) => x.severity === 'error')).toEqual(
      [],
    );
    const paths = validateConfig({
      cache: { warm: { hot: { limit: 0, days: 400, minViews: 0, dataset: 'not a dataset', datasetEnv: 3 } } },
    })
      .filter((x) => x.severity === 'error')
      .map((x) => x.path);
    for (const key of ['limit', 'days', 'minViews', 'dataset', 'datasetEnv'])
      expect(paths).toContain(`cache.warm.hot.${key}`);
    expect(validateConfig({ cache: { warm: { hot: 'yes' } } }).some((x) => x.severity === 'error')).toBe(
      true,
    );
  });
});

describe('validateConfig', () => {
  it('validates experiments', () => {
    const errorsOf = (definitions: Record<string, unknown>) =>
      validateConfig({ flags: { definitions } })
        .filter((x) => x.severity === 'error')
        .map((x) => x.path);
    expect(
      errorsOf({ checkout: { default: 'control', experiment: { variants: { control: 50, b: 50 } } } }),
    ).toEqual([]);
    expect(errorsOf({ x: { default: 'a', experiment: { variants: { a: 1 } } } })).toContain(
      'flags.definitions.x.experiment.variants',
    );
    expect(errorsOf({ x: { default: 'c', experiment: { variants: { a: 1, b: 1 } } } })).toContain(
      'flags.definitions.x.default',
    );
    expect(errorsOf({ x: { default: 'a', experiment: { variants: { a: 1, 'b c': 0 } } } })).toEqual(
      expect.arrayContaining(['flags.definitions.x.experiment.variants.b c']),
    );
    expect(
      errorsOf({ x: { default: 'a', experiment: { variants: { a: 1, b: -2 }, traffic: 140 } } }),
    ).toEqual(
      expect.arrayContaining([
        'flags.definitions.x.experiment.variants.b',
        expect.stringContaining('traffic'),
      ]),
    );
    expect(
      errorsOf({
        x: { default: 'a', experiment: { variants: { a: 1, b: 1 }, status: 'concluded', winner: 'z' } },
      }),
    ).toContain('flags.definitions.x.experiment.winner');
    expect(errorsOf({ 'bad name': { default: 'a', experiment: { variants: { a: 1, b: 1 } } } })).toEqual(
      expect.arrayContaining([expect.stringContaining('bad name')]),
    );
  });

  it('warns about a concluded experiment without a winner and about ignored rules', () => {
    const d = validateConfig({
      flags: {
        definitions: {
          x: { default: 'a', experiment: { variants: { a: 1, b: 1 }, status: 'concluded' } },
          y: {
            default: 'a',
            rules: [{ when: { country: ['US'] }, value: 'b' }],
            experiment: { variants: { a: 1, b: 1 } },
          },
        },
      },
    });
    const warnings = d.filter((x) => x.severity === 'warning').map((x) => x.path);
    expect(warnings).toEqual(
      expect.arrayContaining(['flags.definitions.x.experiment.winner', 'flags.definitions.y.rules']),
    );
  });

  it('validates the experiment cookie and exposures settings', () => {
    expect(
      validateConfig({
        flags: { experimentCookie: 'hyp_exp', exposures: 'log', exposuresBinding: 'AE' },
      }).filter((x) => x.severity === 'error'),
    ).toEqual([]);
    const paths = validateConfig({ flags: { experimentCookie: 3, exposures: 'everywhere' } })
      .filter((x) => x.severity === 'error')
      .map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(['flags.experimentCookie', 'flags.exposures']));
  });

  it('validates cache.edge.bypass', () => {
    const d = validateConfig({ cache: { edge: { bypass: { cookies: 'site_gate' } } } });
    expect(d.filter((x) => x.severity === 'error').map((x) => x.path)).toContain('cache.edge.bypass.cookies');
  });

  it('accepts a valid config without errors', () => {
    const d = validateConfig({
      site: { name: 'shop', origin: 'https://shop.example' },
      security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 100, window: '1m' }] },
      i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
    });
    expect(d.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('reports type errors with paths', () => {
    const d = validateConfig({
      security: { csp: { mode: 'nope' }, rateLimit: [{ id: 'a', match: 'api', limit: -1, window: 'soon' }] },
    });
    const messages = d.filter((x) => x.severity === 'error').map((x) => x.path);
    expect(messages).toContain('security.csp.mode');
    expect(messages).toContain('security.rateLimit[0].match');
    expect(messages).toContain('security.rateLimit[0].limit');
    expect(messages).toContain('security.rateLimit[0].window');
  });

  it('warns on unknown keys and reports semantic problems', () => {
    const d = validateConfig({
      bogus: 1,
      security: {
        rateLimit: [
          { id: 'dup', match: '/a', limit: 1, window: '30s', store: 'binding' },
          { id: 'dup', match: '/b', limit: 1, window: 60 },
        ],
      },
      i18n: { locales: ['en'], defaultLocale: 'fr' },
      jobs: { cron: { bad: { cron: '* *', path: 'nope' } } },
    });
    expect(d.find((x) => x.path === 'bogus')?.severity).toBe('warning');
    expect(d.some((x) => x.message.includes('10s or 60s'))).toBe(true);
    expect(d.some((x) => x.message.includes('duplicate policy id'))).toBe(true);
    expect(d.some((x) => x.path === 'i18n.defaultLocale')).toBe(true);
    expect(d.some((x) => x.path === 'jobs.cron.bad.cron')).toBe(true);
    expect(d.some((x) => x.path === 'jobs.cron.bad.path')).toBe(true);
  });

  it('validates observe.vitals.dashboard', () => {
    expect(
      validateConfig({
        observe: { vitals: { dashboard: { dataset: 'shop_vitals', days: 14, sessionMinutes: 60 } } },
      }).filter((x) => x.severity === 'error'),
    ).toEqual([]);
    expect(
      validateConfig({ observe: { vitals: { dashboard: true } } }).filter((x) => x.severity === 'error'),
    ).toEqual([]);
    const d = validateConfig({
      observe: {
        vitals: {
          dashboard: {
            dataset: 'not a dataset',
            days: 400,
            sessionMinutes: 5000,
            cacheSeconds: -1,
            tokenEnv: 3,
          },
        },
      },
    });
    const paths = d.filter((x) => x.severity === 'error').map((x) => x.path);
    for (const path of ['dataset', 'days', 'sessionMinutes', 'cacheSeconds', 'tokenEnv'])
      expect(paths).toContain(`observe.vitals.dashboard.${path}`);
    expect(
      validateConfig({ observe: { vitals: { dashboard: 'yes' } } }).some((x) => x.severity === 'error'),
    ).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateConfig(null)[0]?.severity).toBe('error');
  });
});

describe('defineConfig / loadConfig', () => {
  it('throws a readable error on invalid config', () => {
    expect(() => defineConfig({ security: { csp: { mode: 'x' as never } } })).toThrow(/security\.csp\.mode/);
  });

  it('caches the resolved config on the object', () => {
    const cfg = defineConfig({ site: { name: 'a' } });
    const r1 = loadConfig(cfg);
    const r2 = loadConfig(cfg);
    expect(r1).toBe(r2);
    expect(r1.site.name).toBe('a');
  });

  it('forwards warnings', () => {
    const warnings: string[] = [];
    loadConfig({ nope: true } as never, { onWarning: (w) => warnings.push(w.path) });
    expect(warnings).toEqual(['nope']);
  });
});

describe('isResolvedConfig', () => {
  it('recognises resolved configs by their brand, never by shape', () => {
    const input = { stages: { disable: ['devtools'] }, site: { name: 'shop' } };
    expect(isResolvedConfig(input)).toBe(false);
    const resolved = resolveConfig(input);
    expect(isResolvedConfig(resolved)).toBe(true);
    expect(isResolvedConfig(loadConfig(input))).toBe(true);
    // The brand is not enumerable: serialisation and spreads stay plain data.
    expect(Object.keys(resolved)).not.toContain('hypdriv.resolved-config');
    expect(isResolvedConfig(JSON.parse(JSON.stringify(resolved)))).toBe(false);
    expect(isResolvedConfig(null)).toBe(false);
  });
});

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
});

describe('validateConfig', () => {
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

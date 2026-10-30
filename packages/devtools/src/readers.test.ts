import { parseServerTiming } from '@hypdriv/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectDevToolsData,
  type DocumentLike,
  decodeFlags,
  normalizeDevState,
  normalizePurser,
  rateVital,
  readAllMeta,
  readBuildMeta,
  readDevState,
  readFlagsMeta,
  readMeta,
  readPurserDiagnostics,
  readRscNavigations,
  readServerTimingEntries,
  rscNavigationFromEntry,
  serverTimingFromEntries,
  summarizeRequest,
} from './readers';

/** Fake document backed by a map of meta name → content. */
function fakeDocument(metas: Record<string, string>): DocumentLike {
  const elements = Object.entries(metas).map(([name, content]) => ({
    getAttribute: (attr: string) => (attr === 'name' ? name : attr === 'content' ? content : null),
  }));
  return {
    querySelector(selector) {
      const m = /meta\[name="([^"]+)"\]/.exec(selector);
      return m ? (elements.find((el) => el.getAttribute('name') === m[1]) ?? null) : null;
    },
    querySelectorAll(selector) {
      const m = /meta\[name\^="([^"]+)"\]/.exec(selector);
      return m ? elements.filter((el) => el.getAttribute('name')?.startsWith(m[1]!)) : [];
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('server timing adapters', () => {
  it('converts PerformanceServerTiming entries to TimingEntry', () => {
    expect(
      serverTimingFromEntries([
        { name: 'cache', duration: 1.2, description: 'HIT' },
        { name: 'csp', duration: 0, description: 'nonce' },
        { name: 'shield', duration: 0, description: '' },
        { name: 'total', duration: 12.5, description: '' },
      ]),
    ).toEqual([
      { name: 'cache', dur: 1.2, desc: 'HIT' },
      { name: 'csp', desc: 'nonce' },
      { name: 'shield', dur: 0 },
      { name: 'total', dur: 12.5 },
    ]);
    expect(serverTimingFromEntries(undefined)).toEqual([]);
  });

  it('summarises the highlighted stages from a header parsed by core', () => {
    const entries = parseServerTiming(
      'cache;desc=HIT;dur=1.2, csp;desc="nonce", bot;desc=human, limit;desc="api:9/10", flags;dur=0.3;desc="3", total;dur=20',
    );
    const summary = summarizeRequest(entries);
    expect(summary).toMatchObject({
      cache: 'HIT',
      csp: 'nonce',
      bot: 'human',
      limit: 'api:9/10',
      flags: '3',
      total: 20,
    });
    expect(summarizeRequest([])).toMatchObject({ cache: null, total: null });
  });

  it('reads the navigation entry through performance when available', () => {
    expect(readServerTimingEntries()).toEqual([]);
    vi.stubGlobal('performance', {
      getEntriesByType: (type: string) =>
        type === 'navigation'
          ? [
              {
                serverTiming: [{ name: 'next', duration: 30, description: '' }],
                responseStart: 120,
                startTime: 0,
              },
            ]
          : type === 'resource'
            ? [
                {
                  name: 'https://app.test/blog?_rsc=abc',
                  initiatorType: 'fetch',
                  startTime: 1,
                  duration: 40,
                  serverTiming: [{ name: 'cache', duration: 0, description: 'MISS' }],
                },
                {
                  name: 'https://app.test/_next/static/x.js',
                  initiatorType: 'script',
                  startTime: 2,
                  duration: 5,
                },
              ]
            : [],
    });
    expect(readServerTimingEntries()).toEqual([{ name: 'next', dur: 30 }]);
    const navs = readRscNavigations();
    expect(navs).toEqual([
      { url: '/blog', startTime: 1, duration: 40, entries: [{ name: 'cache', desc: 'MISS' }], cache: 'MISS' },
    ]);
    const data = collectDevToolsData(fakeDocument({}));
    expect(data.vitals.TTFB).toMatchObject({ name: 'TTFB', value: 120, rating: 'good' });
    expect(data.navigations).toHaveLength(1);
  });

  it('filters non-RSC resources', () => {
    expect(rscNavigationFromEntry({ name: 'https://x/y', startTime: 0, duration: 1 })).toBeNull();
    expect(
      rscNavigationFromEntry({ name: 'https://x/y?_rsc=1', initiatorType: 'img', startTime: 0, duration: 1 }),
    ).toBeNull();
    expect(rscNavigationFromEntry({ name: 'not a url?_rsc=1', startTime: 0, duration: 1 })?.url).toBe(
      'not a url?_rsc=1',
    );
  });
});

describe('rateVital', () => {
  it('applies web.dev thresholds', () => {
    expect(rateVital('LCP', 2500)).toBe('good');
    expect(rateVital('LCP', 2501)).toBe('needs-improvement');
    expect(rateVital('LCP', 4001)).toBe('poor');
    expect(rateVital('CLS', 0.05)).toBe('good');
    expect(rateVital('CLS', 0.3)).toBe('poor');
    expect(rateVital('INP', 300)).toBe('needs-improvement');
    expect(rateVital('TTFB', 100)).toBe('good');
  });
});

describe('meta readers', () => {
  const doc = fakeDocument({
    'hypdriv:build': 'b123',
    'hypdriv:route': 'app:/blog/[slug]',
    'hypdriv:runner': 'worker',
    'hypdriv:flags': btoa('{"beta":true,"variant":"b","n":2,"bad":{"x":1}}').replace(/=+$/, ''),
    'hypdriv:custom': 'yes',
    'other:tag': 'ignored',
    'hypdriv:empty': '',
  });

  it('reads single tags with or without prefix', () => {
    expect(readMeta('build', doc)).toBe('b123');
    expect(readMeta('hypdriv:route', doc)).toBe('app:/blog/[slug]');
    expect(readMeta('missing', doc)).toBeNull();
    expect(readMeta('empty', doc)).toBeNull();
    expect(readMeta('build')).toBeNull(); // no global document in Node
  });

  it('reads all hypdriv tags, flags and build info', () => {
    expect(readAllMeta(doc)).toEqual({
      build: 'b123',
      route: 'app:/blog/[slug]',
      runner: 'worker',
      flags: expect.any(String),
      custom: 'yes',
    });
    expect(readFlagsMeta(doc)).toEqual({ beta: true, variant: 'b', n: 2 });
    expect(readBuildMeta(doc)).toMatchObject({
      build: 'b123',
      route: 'app:/blog/[slug]',
      runner: 'worker',
      extra: { custom: 'yes' },
    });
    expect(readBuildMeta(fakeDocument({})).build).toBeNull();
    expect(
      readBuildMeta(
        fakeDocument({ 'hypdriv:request': 'r1', 'hypdriv:locale': 'en', 'hypdriv:hypdriv': '0.1.0' }),
      ),
    ).toMatchObject({ requestId: 'r1', locale: 'en', hypdrivVersion: '0.1.0', extra: {} });
  });

  it('uses the global document when present', () => {
    vi.stubGlobal('document', fakeDocument({ 'hypdriv:build': 'global' }));
    expect(readMeta('build')).toBe('global');
    expect(readBuildMeta().build).toBe('global');
  });

  it('decodeFlags tolerates raw JSON and rejects garbage', () => {
    expect(decodeFlags('{"a":1}')).toEqual({ a: 1 });
    expect(decodeFlags('%%%')).toBeNull();
    expect(decodeFlags(btoa('[1]'))).toBeNull();
    expect(decodeFlags(null)).toBeNull();
  });
});

describe('dev endpoint readers', () => {
  it('normalises purser diagnostics from several shapes', () => {
    expect(normalizePurser(null)).toBeNull();
    expect(
      normalizePurser({
        ok: false,
        atoms: 120,
        builtAt: '2026-10-30T00:00:00Z',
        durationMs: 42,
        diagnostics: [
          {
            severity: 'error',
            message: 'Unknown atom x-foo',
            file: 'app/page.tsx',
            line: 12,
            column: 3,
            code: 'E_ATOM',
          },
          'plain note',
        ],
        warnings: [{ text: 'unused atom', path: 'app/purser.css' }],
      }),
    ).toEqual({
      ok: false,
      atoms: 120,
      builtAt: '2026-10-30T00:00:00Z',
      durationMs: 42,
      stylesheet: null,
      diagnostics: [
        {
          severity: 'error',
          message: 'Unknown atom x-foo',
          file: 'app/page.tsx',
          line: 12,
          column: 3,
          code: 'E_ATOM',
        },
        { severity: 'info', message: 'plain note' },
        { severity: 'warning', message: 'unused atom', file: 'app/purser.css' },
      ],
    });
    expect(
      normalizePurser({ result: { errors: [{ message: 'boom', level: 'fatal' }], out: 'app/purser.css' } }),
    ).toMatchObject({
      ok: false,
      stylesheet: 'app/purser.css',
      diagnostics: [{ severity: 'error', message: 'boom' }],
    });
    expect(normalizePurser({})).toMatchObject({ ok: true, diagnostics: [] });
  });

  it('readPurserDiagnostics and readDevState return null when the bridge is unreachable', async () => {
    const fetch404 = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await readPurserDiagnostics('/_hypdriv/dev/', fetch404)).toBeNull();
    expect(String((fetch404 as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toBe(
      '/_hypdriv/dev/purser',
    );
    const throwing = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await readDevState('/_hypdriv/dev', throwing)).toBeNull();
    expect(await readDevState('/_hypdriv/dev', undefined)).toBeNull();
  });

  it('readDevState normalises the state payload', async () => {
    const fetchOk = (async () =>
      Response.json({
        capabilities: { kv: true, channel: false, queues: ['jobs'] },
        summary: ['cache: Cache API (per colo)'],
        config: { flags: { provider: 'static' } },
        runner: 'worker',
        buildId: 'b1',
        hypdrivVersion: '0.1.0',
        nextVersion: '16.4.3',
      })) as unknown as typeof fetch;
    const state = await readDevState('/_hypdriv/dev', fetchOk);
    expect(state).toMatchObject({
      capabilities: { kv: true, channel: false, queues: ['jobs'] },
      summary: ['cache: Cache API (per colo)'],
      config: { flags: { provider: 'static' } },
      runner: 'worker',
      buildId: 'b1',
      hypdrivVersion: '0.1.0',
      nextVersion: '16.4.3',
    });
    expect(normalizeDevState('nope')).toBeNull();
    expect(normalizeDevState({})).toMatchObject({
      capabilities: null,
      summary: [],
      config: null,
      details: {},
    });
    // The Worker shell's short spelling plus extra keys.
    expect(
      normalizeDevState({
        build: 'b2',
        next: '16.4.3',
        hypdriv: '0.1.0',
        runner: 'worker',
        development: true,
        stages: { disable: [] },
        routes: [],
      }),
    ).toMatchObject({
      buildId: 'b2',
      nextVersion: '16.4.3',
      hypdrivVersion: '0.1.0',
      development: true,
      details: { stages: { disable: [] }, routes: [] },
    });
  });
});

describe('request facts from Server-Timing', () => {
  it('reads hyp-* entries and lets them override meta tags', async () => {
    const { mergeBuildInfo, readRequestFacts } = await import('./readers');
    const facts = readRequestFacts([
      { name: 'hyp-request', desc: 'req-1' },
      { name: 'hyp-runner', desc: 'worker' },
      { name: 'hyp-route', desc: 'app:/' },
      { name: 'cache', desc: 'HIT' },
    ]);
    expect(facts).toEqual({ request: 'req-1', runner: 'worker', route: 'app:/' });
    const merged = mergeBuildInfo(
      { build: 'b1', route: null, runner: 'proxy', deployment: null, requestId: null, locale: null, cache: null, csp: null, nextVersion: null, hypdrivVersion: '0.1.0', extra: {} },
      facts,
    );
    expect(merged).toMatchObject({ build: 'b1', route: 'app:/', runner: 'worker', requestId: 'req-1', hypdrivVersion: '0.1.0' });
  });
});

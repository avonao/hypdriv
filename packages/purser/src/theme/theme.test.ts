import vm from 'node:vm';
import { cspHash, HypDrivError, type PurserThemeAxis, resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import {
  allThemeClasses,
  decodeThemeHeader,
  encodeThemeCookieValue,
  parseThemeCookie,
  type ThemeConfig,
  themeAxes,
  themeClientHints,
} from './axes';
import { resolveTheme } from './resolve';
import { buildThemeScript, themeScriptHash, themeScriptTag } from './script';

function theme(overrides: Partial<ThemeConfig> = {}, axes?: Record<string, PurserThemeAxis>): ThemeConfig {
  const resolved = resolveConfig({
    purser: {
      theme: {
        axes: axes ?? {
          mode: {
            classes: { light: null, dark: 'dark' },
            default: 'light',
            clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } },
          },
          contrast: {
            cookie: 'c',
            classes: { normal: null, high: 'hc' },
            default: 'normal',
            clientHint: { hint: 'prefers-contrast', values: { more: 'high' } },
          },
        },
      },
    },
  }).purser!.theme!;
  return { ...resolved, ...overrides };
}

const cookieFor = (pairs: string) => ({ hyp_theme: pairs });
const headers = (init: Record<string, string> = {}) => new Headers(init);

describe('resolveTheme', () => {
  it('uses the cookie when it holds a valid value', () => {
    const r = resolveTheme(theme(), { cookies: cookieFor('mode=dark;c=high'), headers: headers() });
    expect(r.values).toEqual({ contrast: 'high', mode: 'dark' });
    expect(r.classes).toEqual(['hc', 'dark']);
    expect(r.sources).toEqual({ contrast: 'cookie', mode: 'cookie' });
    expect(r.header).toBe('contrast=high;mode=dark');
  });

  it('cookie beats the client hint, the hint beats the default', () => {
    const r = resolveTheme(theme(), {
      cookies: cookieFor('mode=light'),
      headers: headers({ 'sec-ch-prefers-color-scheme': 'dark', 'sec-ch-prefers-contrast': 'more' }),
    });
    expect(r.values).toEqual({ contrast: 'high', mode: 'light' });
    expect(r.sources).toEqual({ contrast: 'hint', mode: 'cookie' });
    expect(r.classes).toEqual(['hc']);
  });

  it('falls back to the client hint and then the default', () => {
    const hinted = resolveTheme(theme(), {
      cookies: {},
      headers: headers({ 'sec-ch-prefers-color-scheme': '"Dark"' }),
    });
    expect(hinted.values.mode).toBe('dark');
    expect(hinted.sources.mode).toBe('hint');
    const none = resolveTheme(theme(), { cookies: {}, headers: headers() });
    expect(none.values).toEqual({ contrast: 'normal', mode: 'light' });
    expect(none.classes).toEqual([]);
    expect(none.sources).toEqual({ contrast: 'default', mode: 'default' });
    expect(none.header).toBe('contrast=normal;mode=light');
  });

  it('ignores invalid cookie and hint values', () => {
    const r = resolveTheme(theme(), {
      cookies: cookieFor('mode=sepia;c=high;junk;=x'),
      headers: headers({ 'sec-ch-prefers-color-scheme': 'purple', 'sec-ch-prefers-contrast': 'less' }),
    });
    expect(r.values).toEqual({ contrast: 'high', mode: 'light' });
    expect(r.sources.mode).toBe('default');
  });

  it('ignores client hints when acceptClientHints is off', () => {
    const r = resolveTheme(theme({ acceptClientHints: false }), {
      cookies: {},
      headers: headers({ 'sec-ch-prefers-color-scheme': 'dark' }),
    });
    expect(r.values.mode).toBe('light');
  });

  it('accepts a bare cookie value for a single-axis theme', () => {
    const single = theme({}, { mode: { classes: { light: null, dark: 'dark' }, default: 'light' } });
    expect(resolveTheme(single, { cookies: cookieFor('dark'), headers: headers() }).values).toEqual({
      mode: 'dark',
    });
    expect(resolveTheme(single, { cookies: cookieFor('mode=dark'), headers: headers() }).values).toEqual({
      mode: 'dark',
    });
    expect(parseThemeCookie('dark', themeAxes(theme()))).toEqual({});
  });

  it('de-duplicates classes shared by axes and reads a custom cookie name', () => {
    const t = theme(
      { cookie: 'prefs' },
      {
        a: { classes: { on: 'shared', off: null }, default: 'off' },
        b: { classes: { on: 'shared', off: null }, default: 'on' },
      },
    );
    const r = resolveTheme(t, { cookies: { prefs: 'a=on' }, headers: headers() });
    expect(r.classes).toEqual(['shared']);
    expect(allThemeClasses(themeAxes(t))).toEqual(['shared']);
  });

  it('round-trips header and cookie encodings', () => {
    const axes = themeAxes(theme());
    expect(decodeThemeHeader('contrast=high;mode=dark')).toEqual({ contrast: 'high', mode: 'dark' });
    expect(decodeThemeHeader(null)).toEqual({});
    expect(encodeThemeCookieValue({ mode: 'dark', contrast: 'high' }, axes)).toBe(
      'contrast%3Dhigh%3Bmode%3Ddark',
    );
    expect(themeClientHints(axes)).toEqual(['prefers-contrast', 'prefers-color-scheme']);
  });
});

describe('themeAxes validation', () => {
  it('rejects values, classes and defaults that cannot travel in a cookie or class attribute', () => {
    const bad = (axes: Record<string, PurserThemeAxis>) => () => themeAxes(theme({}, axes));
    expect(bad({ mode: { classes: { 'a=b': 'x' }, default: 'a=b' } })).toThrow(HypDrivError);
    expect(bad({ mode: { classes: { dark: 'dark theme' }, default: 'dark' } })).toThrow(/single class name/);
    expect(bad({ mode: { classes: { dark: 'dark' }, default: 'light' } })).toThrow(/default/);
    expect(bad({ mode: { classes: {}, default: 'x' } })).toThrow(/at least one value/);
    expect(
      bad({
        mode: {
          classes: { dark: 'dark' },
          default: 'dark',
          clientHint: { hint: 'prefers-color-scheme', values: { dark: 'nope' } },
        },
      }),
    ).toThrow(/clientHint.values.dark/);
    expect(
      bad({
        a: { cookie: 'k', classes: { x: null }, default: 'x' },
        b: { cookie: 'k', classes: { x: null }, default: 'x' },
      }),
    ).toThrow(/used by another axis/);
    expect(() => themeAxes(theme({ cookie: 'bad;name' }))).toThrow(/cookie/);
  });
});

interface FakeDom {
  cookie?: string | (() => string);
  classes?: string[];
  media?: Record<string, boolean>;
  noMatchMedia?: boolean;
  noDocument?: boolean;
}

function runScript(script: string, dom: FakeDom = {}) {
  const classes = new Set(dom.classes ?? []);
  const attrs: Record<string, string> = {};
  const documentElement = {
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
  };
  const document: Record<string, unknown> = { documentElement };
  Object.defineProperty(document, 'cookie', {
    get() {
      return typeof dom.cookie === 'function' ? dom.cookie() : (dom.cookie ?? '');
    },
  });
  const context: Record<string, unknown> = {};
  if (!dom.noDocument) context.document = document;
  if (!dom.noMatchMedia) context.matchMedia = (q: string) => ({ matches: dom.media?.[q] ?? false });
  vm.runInNewContext(script, context, { timeout: 1000 });
  return { classes: [...classes].sort(), attrs };
}

describe('buildThemeScript', () => {
  it('is byte-identical for equal configuration regardless of key order and contains no nonce', async () => {
    const a = buildThemeScript(theme());
    const shuffled = theme(
      {},
      {
        contrast: {
          cookie: 'c',
          default: 'normal',
          classes: { high: 'hc', normal: null },
          clientHint: { hint: 'prefers-contrast', values: { more: 'high' } },
        },
        mode: {
          default: 'light',
          clientHint: { hint: 'prefers-color-scheme', values: { light: 'light', dark: 'dark' } },
          classes: { dark: 'dark', light: null },
        },
      },
    );
    expect(buildThemeScript(shuffled)).toBe(a);
    expect(a).not.toMatch(/nonce/i);
    expect(a).not.toMatch(/\s{2,}|\n/);
    expect(a).not.toContain('</script');
    expect(await themeScriptHash(theme())).toBe(await cspHash(a));
    expect(themeScriptTag(theme(), 'abc+/=')).toBe(
      `<script data-hypdriv="theme" nonce="abc+/=">${a}</script>`,
    );
    expect(themeScriptTag(theme())).toBe(`<script data-hypdriv="theme">${a}</script>`);
  });

  it('applies the cookie before paint and marks the document', () => {
    const r = runScript(buildThemeScript(theme()), {
      cookie: 'other=1; hyp_theme=mode%3Ddark%3Bc%3Dhigh; x=y',
    });
    expect(r.classes).toEqual(['dark', 'hc']);
    expect(r.attrs['data-hypdriv-theme']).toBe('contrast=high;mode=dark');
  });

  it('falls back to matchMedia for axes with client hints, then to defaults', () => {
    const script = buildThemeScript(theme());
    expect(runScript(script, { media: { '(prefers-color-scheme: dark)': true } }).classes).toEqual(['dark']);
    expect(runScript(script, { media: { '(prefers-contrast: more)': true } }).classes).toEqual(['hc']);
    const none = runScript(script, {});
    expect(none.classes).toEqual([]);
    expect(none.attrs['data-hypdriv-theme']).toBe('contrast=normal;mode=light');
  });

  it('ignores invalid cookie values and removes stale theme classes while keeping others', () => {
    const r = runScript(buildThemeScript(theme()), {
      cookie: 'hyp_theme=mode%3Dsepia%3Bc%3Dhigh',
      classes: ['__font_abc', 'dark'],
      media: { '(prefers-color-scheme: dark)': false },
    });
    expect(r.classes).toEqual(['__font_abc', 'hc']);
  });

  it('accepts a bare single-axis cookie value', () => {
    const single = theme({}, { mode: { classes: { light: null, dark: 'dark' }, default: 'light' } });
    expect(runScript(buildThemeScript(single), { cookie: 'hyp_theme=dark' }).classes).toEqual(['dark']);
  });

  it('never throws when APIs are missing or cookies are unreadable', () => {
    const script = buildThemeScript(theme());
    expect(runScript(script, { noMatchMedia: true }).classes).toEqual([]);
    expect(
      runScript(script, {
        cookie: () => {
          throw new Error('blocked');
        },
        media: { '(prefers-color-scheme: dark)': true },
      }).classes,
    ).toEqual(['dark']);
    expect(runScript(script, { cookie: 'hyp_theme=%E0%A4%A' }).classes).toEqual([]);
    expect(() => runScript(script, { noDocument: true })).not.toThrow();
  });
});

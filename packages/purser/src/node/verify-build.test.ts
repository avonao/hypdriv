import { join } from 'node:path';
import { cspHash, type ResolvedPurser, resolveConfig } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildThemeScript } from '../theme/script';
import { createFakeProject, type FakeProject, FIXTURE_CSS } from './__fixtures__/project';
import { verifyBuild } from './verify-build';

const projects: FakeProject[] = [];
const project = (...args: Parameters<typeof createFakeProject>) => {
  const p = createFakeProject(...args);
  projects.push(p);
  return p;
};
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

const config = (overrides: Record<string, unknown> = {}): ResolvedPurser =>
  resolveConfig({ purser: { ...overrides } }).purser!;

const html = {
  '/': '<html><body><div class="xce3dr7w x27bzpr0">a</div></body></html>',
  '/blog/[slug]':
    '<html><body><p class="xq3vd17w"></p><script>self.__next_f.push([1,"{\\"className\\":\\"xce3dr7w xzzzzz01\\"}"])</script></body></html>',
};

describe('verifyBuild', () => {
  it('builds the manifest section and fails on missing atoms when verify is "error"', async () => {
    const p = project({ purser: false, files: { 'app/purser.css': FIXTURE_CSS } });
    const result = await verifyBuild({ projectDir: p.dir, config: config(), prerenderedHtml: html });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.missingCount).toBe(1);
    expect(result.errors[0]).toContain('1 Purser class referenced by prerendered HTML is missing');
    expect(result.errors[1]).toBe('/blog/[slug]: 1 unstyled atom: xzzzzz01');
    expect(result.stylesheetFile).toBe(join(p.dir, 'app', 'purser.css'));
    expect(result.manifest).toMatchObject({
      stylesheet: 'app/purser.css',
      atoms: 3,
      prefix: 'x',
      layers: { tokens: 'purser.tokens', globals: 'purser.globals', atoms: 'purser.atoms' },
      atomsByRoute: { '/': ['x27bzpr0', 'xce3dr7w'], '/blog/[slug]': ['xce3dr7w', 'xq3vd17w'] },
      unusedAtoms: [],
      missingAtoms: { '/blog/[slug]': ['xzzzzz01'] },
    });
    expect(result.manifest.stylesheetHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.manifest.themeScript).toBeUndefined();
  });

  it('reports instead of failing with verify "warn" and skips the check with "off"', async () => {
    const p = project({ purser: false, files: { 'app/purser.css': FIXTURE_CSS } });
    const warn = await verifyBuild({
      projectDir: p.dir,
      config: config({ verify: 'warn' }),
      prerenderedHtml: html,
    });
    expect(warn.ok).toBe(true);
    expect(warn.errors).toEqual([]);
    expect(warn.warnings.some((w) => w.includes('xzzzzz01'))).toBe(true);
    const off = await verifyBuild({
      projectDir: p.dir,
      config: config({ verify: 'off', usageReport: false }),
      prerenderedHtml: async () => html,
    });
    expect(off.ok).toBe(true);
    expect(off.skipped).toBe(true);
    expect(off.missingCount).toBe(1);
    expect(off.manifest.missingAtoms).toEqual({ '/blog/[slug]': ['xzzzzz01'] });
    expect(off.manifest.atomsByRoute).toEqual({});
    expect(off.manifest.unusedAtoms).toEqual([]);
    expect(off.warnings).toEqual([]);
  });

  it('includes the theme fallback script and its CSP hash when a theme is configured', async () => {
    const p = project({ purser: false, files: { 'styles/p.css': FIXTURE_CSS } });
    const themed = config({
      out: 'styles/p.css',
      theme: { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light' } } },
    });
    const result = await verifyBuild({
      projectDir: p.dir,
      config: themed,
      prerenderedHtml: { '/': html['/'] },
    });
    expect(result.ok).toBe(true);
    expect(result.manifest.themeScript).toBe(buildThemeScript(themed.theme!));
    expect(result.manifest.themeScriptHash).toBe(await cspHash(result.manifest.themeScript!));
    expect(result.manifest.unusedAtoms).toEqual(['xq3vd17w']);
    const noScript = await verifyBuild({
      projectDir: p.dir,
      config: { ...themed, theme: { ...themed.theme!, fallbackScript: false } },
      prerenderedHtml: {},
    });
    expect(noScript.manifest.themeScript).toBeUndefined();
    expect(noScript.warnings[0]).toContain('No prerendered HTML');
  });

  it('handles a missing stylesheet per verify level and an explicit cssPath', async () => {
    const p = project({ purser: false, files: { 'custom.css': FIXTURE_CSS } });
    const missing = await verifyBuild({ projectDir: p.dir, config: config(), prerenderedHtml: html });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain('not found');
    const warned = await verifyBuild({
      projectDir: p.dir,
      config: config({ verify: 'warn' }),
      prerenderedHtml: html,
    });
    expect(warned.ok).toBe(true);
    expect(warned.warnings[0]).toContain('not found');
    const explicit = await verifyBuild({
      projectDir: p.dir,
      config: config(),
      prerenderedHtml: { '/': html['/'] },
      cssPath: 'custom.css',
    });
    expect(explicit.ok).toBe(true);
    expect(explicit.manifest.stylesheet).toBe('custom.css');
  });

  it('warns when the stylesheet layers differ from the configuration', async () => {
    const css = FIXTURE_CSS.replace('@layer purser.tokens, purser.globals, purser.atoms;', '@layer a, b, c;');
    const p = project({ purser: false, files: { 'app/purser.css': css } });
    const result = await verifyBuild({
      projectDir: p.dir,
      config: config(),
      prerenderedHtml: { '/': html['/'] },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain('declares layers a, b, c');
  });
});

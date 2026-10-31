import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HostPluginApi, loadHypConfig, VIRTUAL_CONFIG } from '@hypdriv/vite';
import { describe, expect, it } from 'vitest';
import { adapterTarget, astroLogger, effectiveConfig } from './integration';
import {
  type AstroBuildFacts,
  astroModuleCode,
  astroVitePlugin,
  cspOverlayCode,
  PRERENDER_ENVIRONMENT,
  VIRTUAL_ASTRO,
} from './vite';

const facts = (over: Partial<AstroBuildFacts> = {}): AstroBuildFacts => ({
  development: false,
  target: 'cloudflare',
  astroCsp: false,
  ...over,
});

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const call = (hook: unknown, self: unknown, ...args: unknown[]) =>
  (typeof hook === 'function' ? hook : (hook as { handler: Hook }).handler).apply(self, args);

function hostApi(root: string): HostPluginApi {
  const loaded = loadHypConfig(root);
  return {
    root,
    config: () => loaded,
    setManifest: () => undefined,
    manifest: () => null,
    isBuild: () => true,
  };
}

describe('virtual:hypdriv/astro', () => {
  it("is 'prerendering' only in the production build of Astro's prerender environment", () => {
    expect(astroModuleCode(facts(), PRERENDER_ENVIRONMENT)).toContain('export const prerendering = true;');
    expect(astroModuleCode(facts(), 'ssr')).toContain('export const prerendering = false;');
    // `astro dev` with Cloudflare's node prerender environment renders real requests there.
    expect(astroModuleCode(facts({ development: true }), PRERENDER_ENVIRONMENT)).toContain(
      'export const prerendering = false;',
    );
    expect(astroModuleCode(facts({ target: null }), 'ssr')).toContain('export const target = null;');
  });

  it('serves the module per Vite environment', async () => {
    const plugin = astroVitePlugin({ facts: () => facts(), host: hostApi(tmpdir()) });
    const id = call(plugin.resolveId, {}, VIRTUAL_ASTRO) as string;
    const prerender = (await call(plugin.load, { environment: { name: 'prerender' } }, id)) as string;
    const ssr = (await call(plugin.load, { environment: { name: 'ssr' } }, id)) as string;
    expect(prerender).toContain('prerendering = true');
    expect(ssr).toContain('prerendering = false');
    expect(ssr).toContain('export const target = "cloudflare";');
  });

  it('bundles HypDriv into every server environment, including prerender', () => {
    const plugin = astroVitePlugin({ facts: () => facts(), host: hostApi(tmpdir()) });
    expect(call(plugin.configEnvironment, {}, 'client', {})).toBeUndefined();
    for (const name of ['ssr', 'prerender', 'astro'])
      expect(call(plugin.configEnvironment, {}, name, {})).toEqual({
        resolve: { noExternal: [/^@hypdriv\//] },
      });
  });
});

describe('Astro security.csp', () => {
  it("overlays the config module with HypDriv's CSP off only when Astro owns the policy", async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-astro-config-'));
    writeFileSync(
      join(root, 'hypdriv.config.mjs'),
      "export default { site: { name: 'x' }, security: { headers: { frameOptions: 'SAMEORIGIN' } } };\n",
    );
    const host = hostApi(root);
    const off = astroVitePlugin({ facts: () => facts(), host });
    expect(call(off.resolveId, {}, VIRTUAL_CONFIG)).toBeNull();
    const on = astroVitePlugin({ facts: () => facts({ astroCsp: true }), host });
    const id = call(on.resolveId, {}, VIRTUAL_CONFIG) as string;
    expect(await call(on.load, { addWatchFile: () => undefined }, id)).toBe(cspOverlayCode());
    const baseId = call(on.resolveId, {}, 'virtual:hypdriv/astro-config-base') as string;
    const base = (await call(on.load, { addWatchFile: () => undefined }, baseId)) as string;
    expect(base).toContain('hypdriv.config.mjs');
    expect(cspOverlayCode()).toContain('csp: false');
  });

  it('finalises the build with the same effective config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-astro-config-'));
    writeFileSync(join(root, 'hypdriv.config.mjs'), "export default { site: { name: 'x' } };\n");
    const loaded = await loadHypConfig(root);
    expect(loaded.resolved.security.csp).not.toBeNull();
    expect(effectiveConfig(loaded, false).security.csp).not.toBeNull();
    expect(effectiveConfig(loaded, true).security.csp).toBeNull();
    expect(effectiveConfig(loaded, true).security.headers).toEqual(loaded.resolved.security.headers);
  });
});

describe('integration helpers', () => {
  it('maps Astro adapters to platforms', () => {
    expect(adapterTarget('@astrojs/cloudflare')).toBe('cloudflare');
    expect(adapterTarget('@astrojs/vercel')).toBe('vercel');
    expect(adapterTarget('@astrojs/vercel/serverless')).toBe('vercel');
    expect(adapterTarget('@astrojs/node')).toBe('node');
    expect(adapterTarget('@astrojs/netlify')).toBeNull();
    expect(adapterTarget(undefined)).toBeNull();
  });

  it("logs through Astro's integration logger", () => {
    const lines: string[] = [];
    const log = astroLogger({
      info: (m) => lines.push(`info ${m}`),
      warn: (m) => lines.push(`warn ${m}`),
      error: (m) => lines.push(`error ${m}`),
      debug: (m) => lines.push(`debug ${m}`),
    });
    log.info('a');
    log.child({}).warn('b');
    expect(lines).toEqual(['info a', 'warn b']);
  });
});

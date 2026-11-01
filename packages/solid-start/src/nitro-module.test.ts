import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { applyNodeRouteRules, installNitroModule, nitroPluginPath, optionsSource } from './nitro-module';
import type { NitroLike } from './target';

function nitro(preset: string, overrides: Partial<NitroLike['options']> = {}): NitroLike {
  return {
    options: {
      preset,
      dev: false,
      plugins: [],
      virtual: {},
      output: { dir: '.output', serverDir: '.output/server', publicDir: '.output/public' },
      routeRules: {},
      ...overrides,
    },
  };
}

const input = {
  pluginPath: () => '/pkg/nitro.js',
  configSource: async () => 'export default {};',
  manifestSource: async () => 'export default {};',
  assetPrefixes: () => ['/_build/assets/'],
};

describe('nitroPluginPath', () => {
  it('uses an explicit path as is', () => {
    expect(nitroPluginPath('/app', '/custom/plugin.ts')).toBe('/custom/plugin.ts');
  });

  it('finds the plugin next to the module (the built package, or the sources in tests)', () => {
    expect(nitroPluginPath('/app')).toMatch(/nitro\.(?:m?js|ts)$/);
  });
});

describe('optionsSource', () => {
  it('serializes the target, development flag and asset prefixes for the runtime plugin', () => {
    const source = optionsSource(nitro('vercel', { dev: true }), ['/_build/assets/']);
    expect(source).toBe(
      'export default {"target":"vercel","development":true,"assetPrefixes":["/_build/assets/"]};\n',
    );
    expect(optionsSource(nitro('node-server'), [])).toContain('"target":"node"');
    expect(optionsSource(nitro('cloudflare_module'), [])).toContain('"target":"cloudflare"');
  });
});

describe('installNitroModule', () => {
  it('registers the runtime plugin and the three virtual modules', async () => {
    const instance = nitro('node-server');
    expect(installNitroModule(instance, input)).toBe(true);
    expect(instance.options.plugins).toEqual(['/pkg/nitro.js']);
    expect(Object.keys(instance.options.virtual).sort()).toEqual([
      'virtual:hypdriv/config',
      'virtual:hypdriv/manifest',
      'virtual:hypdriv/solid-start',
    ]);
    const options = instance.options.virtual['virtual:hypdriv/solid-start'];
    expect(typeof options === 'function' ? await options() : options).toContain('"target":"node"');
  });

  it('does not register the plugin twice', () => {
    const instance = nitro('node-server', { plugins: ['/pkg/nitro.js'] });
    installNitroModule(instance, input);
    expect(instance.options.plugins).toEqual(['/pkg/nitro.js']);
  });

  it('leaves Nitro’s prerender build alone, so prerendered pages carry no per-request state', () => {
    const instance = nitro('nitro-prerender');
    expect(installNitroModule(instance, input)).toBe(false);
    expect(instance.options.plugins).toEqual([]);
    expect(instance.options.virtual).toEqual({});
  });
});

describe('applyNodeRouteRules', () => {
  const config = resolveConfig({ site: { name: 'solid-test' } });

  it('gives hashed assets the static security headers and the immutable cache header on a Node server', () => {
    const instance = nitro('node-server');
    applyNodeRouteRules(instance, config, ['/_build/assets/']);
    const rule = instance.options.routeRules['/_build/assets/**'];
    expect(rule?.headers).toMatchObject({
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
  });

  it('keeps headers the application or Nitro already set', () => {
    const instance = nitro('node-server', {
      routeRules: {
        '/_build/assets/**': { headers: { 'cache-control': 'public, max-age=60', 'x-custom': '1' } },
      },
    });
    applyNodeRouteRules(instance, config, ['/_build/assets/']);
    expect(instance.options.routeRules['/_build/assets/**']?.headers).toMatchObject({
      'cache-control': 'public, max-age=60',
      'x-custom': '1',
      'x-content-type-options': 'nosniff',
    });
  });

  it('respects a pattern whose headers the application switched off', () => {
    const instance = nitro('node-server', { routeRules: { '/_build/assets/**': { headers: false } } });
    applyNodeRouteRules(instance, config, ['/_build/assets/']);
    expect(instance.options.routeRules['/_build/assets/**']).toEqual({ headers: false });
  });

  it('writes nothing for Vercel and Cloudflare (their build output carries the rules)', () => {
    for (const preset of ['vercel', 'cloudflare_module']) {
      const instance = nitro(preset);
      applyNodeRouteRules(instance, config, ['/_build/assets/']);
      expect(instance.options.routeRules).toEqual({});
    }
  });
});

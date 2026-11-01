import { describe, expect, it } from 'vitest';
import { wakuAdapterWiring, wakuCloudflarePlugin, wakuVersionSupported } from './waku';

describe('wakuAdapterWiring', () => {
  it('recognises withHypDriv() around the config', () => {
    const config =
      "import { withHypDriv } from '@hypdriv/waku';\nexport default defineConfig(withHypDriv({}));\n";
    expect(wakuAdapterWiring(config, null)).toBe('withHypDriv');
  });

  it('recognises an explicit adapter in the config or in the server entry', () => {
    expect(
      wakuAdapterWiring("export default { unstable_adapter: '@hypdriv/waku/adapters/node' };", null),
    ).toBe('unstable_adapter');
    expect(
      wakuAdapterWiring('export default {};', "import adapter from '@hypdriv/waku/adapters/cloudflare';"),
    ).toBe('server-entry');
  });

  it('finds nothing in a config that only registers the plugin or uses Waku’s own adapter', () => {
    expect(wakuAdapterWiring("vite: { plugins: [hypdriv()] } // from '@hypdriv/waku'", null)).toBeNull();
    expect(wakuAdapterWiring("export default { unstable_adapter: 'waku/adapters/node' };", null)).toBeNull();
    expect(
      wakuAdapterWiring('export default {};', "import adapter from 'waku/adapters/cloudflare';"),
    ).toBeNull();
  });
});

describe('wakuCloudflarePlugin', () => {
  it('accepts the plugin on the rsc environment', () => {
    const source = `import { cloudflare } from '@cloudflare/vite-plugin';
export default { vite: { plugins: [cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })] } };`;
    expect(wakuCloudflarePlugin(source)).toBe('ok');
  });

  it('flags the plugin without Waku’s environment', () => {
    const source = "import { cloudflare } from '@cloudflare/vite-plugin';\nplugins: [cloudflare()]";
    expect(wakuCloudflarePlugin(source)).toBe('environment');
    expect(
      wakuCloudflarePlugin(
        "plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } })]; // @cloudflare/vite-plugin",
      ),
    ).toBe('environment');
  });

  it('flags a config without the plugin', () => {
    expect(wakuCloudflarePlugin('export default defineConfig(withHypDriv({}));')).toBe('missing');
    expect(wakuCloudflarePlugin("import { cloudflare } from '@cloudflare/vite-plugin';")).toBe('missing');
  });
});

describe('wakuVersionSupported', () => {
  it('accepts 1.0.0-rc.4 and later 1.x releases', () => {
    for (const version of ['1.0.0-rc.4', '1.0.0-rc.12', '1.0.0', '1.0.1-beta.1', '1.2.3'])
      expect(wakuVersionSupported(version), version).toBe(true);
  });

  it('rejects earlier pre-releases and other majors', () => {
    for (const version of ['1.0.0-rc.3', '1.0.0-beta.5', '0.27.0', '2.0.0'])
      expect(wakuVersionSupported(version), version).toBe(false);
  });

  it('does not judge a version it cannot read', () => {
    expect(wakuVersionSupported('latest')).toBe(true);
  });
});

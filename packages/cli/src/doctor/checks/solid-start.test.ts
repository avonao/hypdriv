import { describe, expect, it } from 'vitest';
import {
  solidStartCloudflareEnvironment,
  solidStartDeployment,
  solidStartMajor,
  solidStartPluginOrder,
  solidStartPlugins,
  solidStartWorkerEntry,
} from './solid-start';

const NITRO = `import { hypdriv } from '@hypdriv/solid-start/vite';
import { solidStart } from '@solidjs/start/config';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [solidStart(), nitro({ preset: 'node-server' }), hypdriv()],
});
`;

const CLOUDFLARE = `import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/solid-start/vite';
import { solidStart } from '@solidjs/start/config';

export default defineConfig({
  plugins: [solidStart(), cloudflare({ viteEnvironment: { name: 'ssr' } }), hypdriv()],
});
`;

describe('solidStartPlugins', () => {
  it('finds the plugin calls in the order they are listed', () => {
    const plugins = solidStartPlugins(NITRO);
    expect(plugins.solidStart).toBeLessThan(plugins.nitro);
    expect(plugins.nitro).toBeLessThan(plugins.hypdriv);
    expect(plugins.cloudflare).toBe(-1);
  });

  it('ignores commented-out plugins and look-alikes', () => {
    const config = `plugins: [
      solidStart(),
      // nitro({ preset: 'vercel' }),
      /* cloudflare() */
      myhypdriv(),
    ]`;
    const plugins = solidStartPlugins(config);
    expect(plugins.nitro).toBe(-1);
    expect(plugins.cloudflare).toBe(-1);
    expect(plugins.hypdriv).toBe(-1);
  });
});

describe('solidStartDeployment', () => {
  it('recognises Nitro and @cloudflare/vite-plugin', () => {
    expect(solidStartDeployment(NITRO)).toBe('nitro');
    expect(solidStartDeployment(CLOUDFLARE)).toBe('cloudflare');
  });

  it('reports both plugins listed together and neither', () => {
    expect(solidStartDeployment(`${CLOUDFLARE}\nplugins.push(nitro());`)).toBe('both');
    expect(solidStartDeployment('plugins: [solidStart(), hypdriv()]')).toBe('none');
    // `cloudflare()` from some other package is not the Vite plugin.
    expect(solidStartDeployment("import { cloudflare } from 'other';\nplugins: [cloudflare()]")).toBe('none');
  });
});

describe('solidStartPluginOrder', () => {
  it('accepts hypdriv() last', () => {
    expect(solidStartPluginOrder(NITRO)).toBe('ok');
    expect(solidStartPluginOrder(CLOUDFLARE)).toBe('ok');
  });

  it('flags hypdriv() before solidStart() or the deployment plugin', () => {
    expect(solidStartPluginOrder('plugins: [hypdriv(), solidStart(), nitro()]')).toBe('before-solid-start');
    expect(solidStartPluginOrder('plugins: [solidStart(), hypdriv(), nitro()]')).toBe('before-deployment');
    expect(
      solidStartPluginOrder("plugins: [solidStart(), hypdriv(), cloudflare()] // '@cloudflare/vite-plugin'"),
    ).toBe('before-deployment');
  });

  it('has nothing to say when hypdriv() is not registered', () => {
    expect(solidStartPluginOrder('plugins: [solidStart(), nitro()]')).toBe('unregistered');
  });
});

describe('solidStartCloudflareEnvironment', () => {
  it('accepts the plugin on the ssr environment', () => {
    expect(solidStartCloudflareEnvironment(CLOUDFLARE)).toBe('ok');
  });

  it('flags the plugin without SolidStart’s environment or without the plugin', () => {
    expect(
      solidStartCloudflareEnvironment(
        "import { cloudflare } from '@cloudflare/vite-plugin';\nplugins: [cloudflare()]",
      ),
    ).toBe('environment');
    expect(
      solidStartCloudflareEnvironment(
        "import { cloudflare } from '@cloudflare/vite-plugin';\nplugins: [cloudflare({ viteEnvironment: { name: 'client' } })]",
      ),
    ).toBe('environment');
    expect(solidStartCloudflareEnvironment(NITRO)).toBe('missing');
    expect(solidStartCloudflareEnvironment("import { cloudflare } from '@cloudflare/vite-plugin';")).toBe(
      'missing',
    );
  });
});

describe('solidStartMajor', () => {
  it('reads installed and declared versions', () => {
    expect(solidStartMajor('2.1.0')).toBe(2);
    expect(solidStartMajor('^2.0.0')).toBe(2);
    expect(solidStartMajor('1.3.2')).toBe(1);
    expect(solidStartMajor('~3.0.0-beta.1')).toBe(3);
    expect(solidStartMajor('latest')).toBeNull();
    expect(solidStartMajor(null)).toBeNull();
  });
});

describe('solidStartWorkerEntry', () => {
  it('recognises the Hypdriv shell and SolidStart’s own entry', () => {
    expect(
      solidStartWorkerEntry("import { createSolidStartWorker } from '@hypdriv/solid-start/cloudflare';"),
    ).toBe('shell');
    expect(
      solidStartWorkerEntry(
        "import { createHandler, StartServer } from '@solidjs/start/server';\nexport default createHandler(() => null);",
      ),
    ).toBe('solid-entry');
    expect(solidStartWorkerEntry('export default { fetch: () => new Response("hi") };')).toBe('other');
  });
});

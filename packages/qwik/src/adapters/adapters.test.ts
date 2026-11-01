import type { Plugin, UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { cloudflareAdapter } from './cloudflare';
import { hypdrivAdapter } from './common';
import { nodeAdapter } from './node';
import { vercelAdapter } from './vercel';

const names = (plugins: Plugin[]) => plugins.map((plugin) => plugin.name);

/** The Vite config an adapter contributes: its `config` hook run against an empty user config. */
async function contributed(plugins: Plugin[], adapterName: string): Promise<UserConfig> {
  const plugin = plugins.find((p) => p.name === `vite-plugin-qwik-router-ssg-${adapterName}`);
  expect(plugin, `${adapterName} adapter plugin`).toBeDefined();
  const hook = plugin?.config;
  const config = typeof hook === 'function' ? hook : hook?.handler;
  return ((await config?.call({} as never, {}, { command: 'build', mode: 'production' })) ??
    {}) as UserConfig;
}

describe('hypdrivAdapter', () => {
  it('adds the origin plugin in front of Qwik’s adapter plugin', () => {
    const plugins = hypdrivAdapter({ name: 'hypdriv-test', options: {}, config: () => ({}) });
    expect(names(plugins)[0]).toBe('hypdriv:qwik-hypdriv-test');
    expect(names(plugins)).toContain('vite-plugin-qwik-router-ssg-hypdriv-test');
    expect(plugins[0]?.apply).toBe('build');
    expect(plugins[0]?.enforce).toBe('pre');
  });

  it('passes the platform’s Vite config through Qwik’s adapter', async () => {
    const plugins = hypdrivAdapter({
      name: 'hypdriv-test',
      options: {},
      config: () => ({ ssr: { target: 'webworker' } }),
    });
    expect((await contributed(plugins, 'hypdriv-test')).ssr?.target).toBe('webworker');
  });
});

describe('platform adapters', () => {
  it('builds for Node as a Node SSR server without the public directory', async () => {
    const config = await contributed(nodeAdapter(), 'hypdriv-node');
    expect(config.ssr?.target).toBe('node');
    expect(config.build?.ssr).toBe(true);
    expect(config.publicDir).toBe(false);
  });

  it('builds for Cloudflare as one ES module with the runtime’s modules left external', async () => {
    const config = await contributed(cloudflareAdapter(), 'hypdriv-cloudflare');
    expect(config.ssr?.target).toBe('webworker');
    expect(config.resolve?.conditions).toEqual(['webworker', 'worker']);
    const rolldown = (
      config.build as { rolldownOptions?: { external?: RegExp[]; output?: { format?: string } } }
    ).rolldownOptions;
    expect(rolldown?.output?.format).toBe('es');
    expect(rolldown?.external?.some((pattern) => pattern.test('cloudflare:workers'))).toBe(true);
    expect(rolldown?.external?.some((pattern) => pattern.test('node:async_hooks'))).toBe(true);
    expect(rolldown?.external?.some((pattern) => pattern.test('./local.js'))).toBe(false);
  });

  it('builds for Vercel as a Node function', async () => {
    const config = await contributed(vercelAdapter(), 'hypdriv-vercel');
    expect(config.build?.ssr).toBe(true);
    expect(config.ssr?.target).toBe('node');
  });
});

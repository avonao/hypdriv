import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { withHypDriv } from './config';

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['HYPDRIV_TARGET', 'VERCEL', 'CLOUDFLARE', 'WORKERS_CI', 'NETLIFY'])
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const names = (plugins: unknown): string[] =>
  (plugins as Plugin[]).flat().map((p) => (p as { name: string }).name);

const cloudflarePlugin = { name: 'vite-plugin-cloudflare' } as Plugin;

describe('withHypDriv', () => {
  it('selects the Hypdriv adapter of the target and adds the plugin', () => {
    process.env.HYPDRIV_TARGET = 'node';
    const config = withHypDriv({ basePath: '/' });
    expect(config.unstable_adapter).toBe('@hypdriv/waku/adapters/node');
    expect(config.basePath).toBe('/');
    expect(names(config.vite?.plugins)).toEqual(['hypdriv:waku', 'hypdriv:waku-entry', 'hypdriv:waku-build']);

    process.env.HYPDRIV_TARGET = 'vercel';
    expect(withHypDriv({}).unstable_adapter).toBe('@hypdriv/waku/adapters/vercel');
  });

  it('follows the build platform when HYPDRIV_TARGET is not set', () => {
    delete process.env.HYPDRIV_TARGET;
    process.env.VERCEL = '1';
    expect(withHypDriv({}).unstable_adapter).toBe('@hypdriv/waku/adapters/vercel');
    delete process.env.VERCEL;
    expect(withHypDriv({}).unstable_adapter).toBe('@hypdriv/waku/adapters/node');
  });

  it('targets Cloudflare when @cloudflare/vite-plugin is configured and no target is set', () => {
    delete process.env.HYPDRIV_TARGET;
    delete process.env.VERCEL;
    const config = withHypDriv({ vite: { plugins: [cloudflarePlugin] } });
    expect(config.unstable_adapter).toBe('@hypdriv/waku/adapters/cloudflare');
    // HYPDRIV_TARGET still wins, so one config serves every platform.
    process.env.HYPDRIV_TARGET = 'node';
    expect(withHypDriv({ vite: { plugins: [cloudflarePlugin] } }).unstable_adapter).toBe(
      '@hypdriv/waku/adapters/node',
    );
  });

  it('keeps an adapter the application chose', () => {
    process.env.HYPDRIV_TARGET = 'node';
    expect(withHypDriv({ unstable_adapter: './my-adapter' }).unstable_adapter).toBe('./my-adapter');
  });

  it('leaves Netlify to Waku’s own adapter', () => {
    delete process.env.HYPDRIV_TARGET;
    process.env.NETLIFY = 'true';
    expect(withHypDriv({}).unstable_adapter).toBeUndefined();
  });

  it('keeps the application’s Vite plugins ahead of its own', () => {
    process.env.HYPDRIV_TARGET = 'node';
    const mine = { name: 'mine' } as Plugin;
    const config = withHypDriv({ vite: { plugins: [mine], resolve: { alias: { '@': '/src' } } } });
    expect(names(config.vite?.plugins)[0]).toBe('mine');
    expect(config.vite?.resolve?.alias).toEqual({ '@': '/src' });
  });

  describe('Cloudflare', () => {
    it('needs @cloudflare/vite-plugin in the plugins', () => {
      process.env.HYPDRIV_TARGET = 'cloudflare';
      expect(() => withHypDriv({})).toThrow(/@cloudflare\/vite-plugin/);
    });

    it('adds the environment settings Waku’s Cloudflare setup needs, under the application’s own', () => {
      process.env.HYPDRIV_TARGET = 'cloudflare';
      const config = withHypDriv({
        vite: {
          plugins: [cloudflarePlugin],
          environments: { rsc: { optimizeDeps: { include: ['extra'] } } },
        },
      });
      expect(config.unstable_adapter).toBe('@hypdriv/waku/adapters/cloudflare');
      const rsc = config.vite?.environments?.rsc;
      expect(rsc?.optimizeDeps?.include).toEqual(['waku > hono/tiny', 'extra']);
      expect(rsc?.build?.rolldownOptions).toEqual({ platform: 'neutral' });
      expect(config.vite?.environments?.ssr?.optimizeDeps?.include).toEqual([
        'waku > rsc-html-stream/server',
      ]);
      expect(names(config.vite?.plugins)[0]).toBe('vite-plugin-cloudflare');
    });
  });
});

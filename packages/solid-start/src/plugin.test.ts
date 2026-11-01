import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIRTUAL_MANIFEST, type ViteManifest } from '@hypdriv/vite';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { chunkKeys, hypdriv } from './plugin';
import type { NitroLike, NitroModuleLike } from './target';

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

type Hook = (...args: never[]) => unknown;
type BuildPlugin = Plugin & { nitro: NitroModuleLike; configResolved: Hook };

const chunk = (extra: Record<string, unknown> = {}) => ({ file: 'assets/x.js', ...extra });

describe('chunkKeys', () => {
  const manifest = {
    'src/entry-client.tsx': chunk({ isEntry: true }),
    'src/routes/about.tsx?pick=default&pick=$css&lang.tsx': chunk(),
    'src/routes/about.tsx?pick=$css&lang.tsx': chunk(),
    'src/routes/posts/[slug].tsx?pick=default&lang.tsx': chunk(),
    'src/routes/index.tsx?pick=default&lang.tsx': chunk(),
    'src/components/button.tsx': chunk(),
  } as unknown as ViteManifest;

  it('finds the manifest entries SolidStart builds for a route file (its source before the ?pick query)', () => {
    expect(chunkKeys(manifest, ['src/routes/about.tsx'])).toEqual([
      'src/routes/about.tsx?pick=default&pick=$css&lang.tsx',
      'src/routes/about.tsx?pick=$css&lang.tsx',
    ]);
    expect(chunkKeys(manifest, ['src/routes/posts/[slug].tsx', 'src/routes/index.tsx'])).toEqual([
      'src/routes/posts/[slug].tsx?pick=default&lang.tsx',
      'src/routes/index.tsx?pick=default&lang.tsx',
    ]);
  });

  it('matches plain keys and ignores other files', () => {
    expect(chunkKeys(manifest, ['src/components/button.tsx'])).toEqual(['src/components/button.tsx']);
    expect(chunkKeys(manifest, ['src/routes/missing.tsx'])).toEqual([]);
    expect(chunkKeys(manifest, [])).toEqual([]);
  });
});

describe('the Vite plugins', () => {
  it('registers the host and the build plugin', () => {
    const plugins = hypdriv();
    expect(plugins.map((p) => p.name)).toEqual(['hypdriv:solid-start', 'hypdriv:solid-start-build']);
    const build = plugins[1] as BuildPlugin;
    expect(build.enforce).toBe('post');
    expect((build as unknown as { buildApp: { order: string } }).buildApp.order).toBe('post');
    expect(build.nitro.name).toBe('hypdriv');
  });

  it('bundles the package into the server environments', () => {
    const host = hypdriv()[0] as unknown as { config: (user: unknown) => unknown };
    expect(host.config({})).toEqual({ ssr: { noExternal: ['@hypdriv/vite', '@hypdriv/solid-start'] } });
    expect(host.config({ ssr: { noExternal: true } })).toEqual({});
  });

  it('serves the development manifest from the route files for virtual:hypdriv/manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-solid-plugin-'));
    created.push(root);
    mkdirSync(join(root, 'src', 'routes', 'posts'), { recursive: true });
    writeFileSync(join(root, 'src', 'routes', 'index.tsx'), 'export default () => null;\n');
    writeFileSync(join(root, 'src', 'routes', 'posts', '[slug].tsx'), 'export default () => null;\n');
    writeFileSync(join(root, 'src', 'routes', 'time.ts'), 'export const GET = () => new Response();\n');
    const host = hypdriv()[0] as unknown as {
      configResolved(config: unknown): void;
      resolveId(id: string): string | null;
      load(id: string): Promise<string | null>;
    };
    host.configResolved({ root, command: 'serve' });
    const resolved = host.resolveId(VIRTUAL_MANIFEST);
    expect(resolved).toBeTruthy();
    const code = (await host.load(resolved as string)) ?? '';
    const literal = /JSON\.parse\((".*")\)/.exec(code)?.[1];
    const manifest = JSON.parse(JSON.parse(literal ?? '""') as string) as {
      framework: { name: string; bundler: string };
      routes: Array<{ id: string; kind: string }>;
    };
    expect(manifest.framework).toMatchObject({ name: 'solid-start', bundler: 'vite' });
    expect(manifest.routes.map((r) => r.id)).toEqual(['page:/', 'page:/posts/[slug]', 'endpoint:/time']);
  });

  it('needs solidStart() to build, but only warns during development', async () => {
    const warn = vi.fn();
    const resolved = (command: 'build' | 'serve', plugins: string[]) =>
      ({ command, root: '/app', logger: { warn }, plugins: plugins.map((name) => ({ name })) }) as never;
    const build = hypdriv()[1] as BuildPlugin;
    await expect(
      build.configResolved(resolved('build', ['hypdriv:solid-start-build']) as never),
    ).rejects.toThrow(/needs solidStart\(\)/);
    await expect(
      build.configResolved(resolved('serve', ['hypdriv:solid-start-build']) as never),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs solidStart()'));
  });

  it('must be listed after nitro(): it finalises once Nitro has built and prerendered', async () => {
    const build = hypdriv()[1] as BuildPlugin;
    const config = {
      command: 'build',
      root: '/app',
      logger: { warn: vi.fn() },
      plugins: [{ name: 'solid-start:config' }, { name: 'hypdriv:solid-start-build' }, { name: 'nitro' }],
    } as never;
    await expect(build.configResolved(config)).rejects.toThrow(/after nitro\(\)/);
  });
});

describe('the Nitro module', () => {
  const nitro = (preset: string): NitroLike => ({
    options: {
      preset,
      plugins: [],
      virtual: {},
      output: { dir: '.output', serverDir: '.output/server', publicDir: '.output/public' },
      routeRules: {},
    },
  });

  it('wraps the build instance and skips the prerender instance', async () => {
    const build = hypdriv()[1] as BuildPlugin;
    const prerender = nitro('nitro-prerender');
    await build.nitro.setup(prerender);
    expect(prerender.options.plugins).toEqual([]);
    expect(prerender.options.virtual).toEqual({});

    const server = nitro('node-server');
    await build.nitro.setup(server);
    expect(server.options.plugins).toHaveLength(1);
    expect(server.options.plugins[0]).toMatch(/nitro\.(?:m?js|ts)$/);
    expect(Object.keys(server.options.virtual).sort()).toEqual([
      'virtual:hypdriv/config',
      'virtual:hypdriv/manifest',
      'virtual:hypdriv/solid-start',
    ]);
  });

  it('uses the Nitro plugin file the application names', async () => {
    const build = hypdriv({ nitroPlugin: '/app/my-nitro-plugin.ts' })[1] as BuildPlugin;
    const server = nitro('vercel');
    await build.nitro.setup(server);
    expect(server.options.plugins).toEqual(['/app/my-nitro-plugin.ts']);
  });
});

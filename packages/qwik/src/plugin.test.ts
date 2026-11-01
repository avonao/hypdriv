import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { basePathOf, buildInputs, hypdriv, qwikVersion, stripBase, VIRTUAL_DURABLE_OBJECTS } from './plugin';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');

describe('base pathname', () => {
  it('turns Qwik’s base pathname into Hypdriv’s base path', () => {
    expect(basePathOf('/')).toBe('');
    expect(basePathOf('/docs/')).toBe('/docs');
    expect(basePathOf('/a/b/')).toBe('/a/b');
  });

  it('strips the base path from route patterns', () => {
    const routes = [
      { pathname: '/docs', kind: 'page' as const },
      { pathname: '/docs/about', kind: 'page' as const },
      { pathname: '/documents', kind: 'page' as const },
      { pathname: '/other', kind: 'endpoint' as const },
    ];
    expect(stripBase(routes, '').map((r) => r.pathname)).toEqual([
      '/docs',
      '/docs/about',
      '/documents',
      '/other',
    ]);
    expect(stripBase(routes, '/docs').map((r) => r.pathname)).toEqual([
      '/',
      '/about',
      '/documents',
      '/other',
    ]);
  });
});

describe('build inputs', () => {
  const vite = (input: unknown) => ({ root: '/app', build: { rolldownOptions: { input } } }) as never;

  it('resolves the server entry files against the root, whatever the shape of the option', () => {
    expect(buildInputs(vite(['src/entry.node.tsx']))).toEqual(['/app/src/entry.node.tsx']);
    expect(buildInputs(vite('src/entry.vercel.tsx'))).toEqual(['/app/src/entry.vercel.tsx']);
    expect(buildInputs(vite({ main: 'src/entry.cloudflare.tsx', other: '/abs/other.ts' }))).toEqual([
      '/app/src/entry.cloudflare.tsx',
      '/abs/other.ts',
    ]);
    expect(buildInputs(vite(undefined))).toEqual([]);
    expect(buildInputs({ root: '/app', build: {} } as never)).toEqual([]);
  });
});

describe('Qwik version', () => {
  it('reads the installed Qwik version from the project', () => {
    expect(qwikVersion(packageDir)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

type Hook = (...args: never[]) => unknown;

function entryPlugin(options: Parameters<typeof hypdriv>[0] = {}) {
  const plugins = hypdriv(options);
  const entry = plugins.find((p) => p.name === 'hypdriv:qwik-entry') as Plugin & Record<string, Hook>;
  return { plugins, entry };
}

const resolved = (root: string, plugins: string[] = [], build: unknown = {}, environment?: unknown) =>
  ({ root, plugins: plugins.map((name) => ({ name })), build, command: 'build', environment }) as never;

const CLOUDFLARE_ENTRY = '/app/src/entry.cloudflare.tsx';

describe('Hypdriv plugins', () => {
  it('registers the host, entry, build and serve plugins', () => {
    const { plugins } = entryPlugin();
    expect(plugins.map((p) => p.name)).toEqual([
      'hypdriv:qwik',
      'hypdriv:qwik-entry',
      'hypdriv:qwik-build',
      'hypdriv:qwik-serve',
    ]);
    const build = plugins[2] as Plugin;
    expect(build.apply).toBe('build');
    expect(build.enforce).toBe('post');
    expect((build.buildApp as { order: string }).order).toBe('post');
    expect(plugins[3]?.enforce).toBe('pre');
  });

  it('bundles the Hypdriv packages into the server environments only', () => {
    const { entry } = entryPlugin();
    const configEnvironment = entry.configEnvironment as unknown as (
      name: string,
      environment: { consumer: string },
    ) => unknown;
    expect(configEnvironment('client', { consumer: 'client' })).toEqual({});
    expect(configEnvironment('ssr', { consumer: 'server' })).toEqual({
      resolve: { noExternal: [/^@hypdriv\//] },
    });
  });

  it('exports the Durable Object classes from the Cloudflare entry once', () => {
    const { entry } = entryPlugin({ target: 'cloudflare' });
    (entry.configResolved as unknown as (c: unknown) => void)(
      resolved('/app', ['vite-plugin-qwik-router-ssg-hypdriv-cloudflare']),
    );
    const transform = entry.transform as unknown as (
      this: unknown,
      code: string,
      id: string,
    ) => { code: string } | null;
    const server = {
      environment: {
        config: { consumer: 'server', build: { rolldownOptions: { input: ['src/entry.cloudflare.tsx'] } } },
      },
    };
    const out = transform.call(server, 'export default {};', CLOUDFLARE_ENTRY);
    expect(out?.code).toContain(`export * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)}`);
    expect(transform.call(server, out?.code ?? '', CLOUDFLARE_ENTRY)).toBeNull();
    // Only the server build’s entry, never other modules or the client build.
    expect(transform.call(server, 'export default {};', '/app/src/other.ts')).toBeNull();
    expect(
      transform.call(
        { environment: { config: { consumer: 'client' } } },
        'export default {};',
        CLOUDFLARE_ENTRY,
      ),
    ).toBeNull();
    expect(transform.call(server, 'export default {};', `${CLOUDFLARE_ENTRY}?v=1`)?.code).toContain(
      'durable-objects',
    );
  });

  it('finds the entry in the build environment’s options when the config’s own input is empty', () => {
    const { entry } = entryPlugin({ target: 'cloudflare' });
    (entry.configResolved as unknown as (c: unknown) => void)(resolved('/app', [], {}));
    const transform = entry.transform as unknown as (this: unknown, code: string, id: string) => unknown;
    const server = {
      environment: {
        config: { consumer: 'server', build: { rolldownOptions: { input: ['src/entry.cloudflare.tsx'] } } },
      },
    };
    expect(transform.call(server, 'export default {};', CLOUDFLARE_ENTRY)).not.toBeNull();
  });

  it('leaves the server entry alone off Cloudflare and when Durable Objects are disabled', () => {
    const server = {
      environment: {
        config: { consumer: 'server', build: { rolldownOptions: { input: ['src/entry.cloudflare.tsx'] } } },
      },
    };
    const transform = (plugin: Plugin & Record<string, Hook>) =>
      plugin.transform as unknown as (this: unknown, code: string, id: string) => unknown;

    const node = entryPlugin({ target: 'node' }).entry;
    (node.configResolved as unknown as (c: unknown) => void)(resolved('/app'));
    expect(transform(node).call(server, 'x', CLOUDFLARE_ENTRY)).toBeNull();

    const off = entryPlugin({ target: 'cloudflare', durableObjects: false }).entry;
    (off.configResolved as unknown as (c: unknown) => void)(resolved('/app'));
    expect(transform(off).call(server, 'x', CLOUDFLARE_ENTRY)).toBeNull();
  });

  it('serves the virtual Durable Object module', () => {
    const { entry } = entryPlugin({ target: 'cloudflare' });
    const resolveId = entry.resolveId as unknown as (id: string) => string | null;
    const load = entry.load as unknown as (id: string) => string | null;
    expect(resolveId(VIRTUAL_DURABLE_OBJECTS)).toBe(`\0${VIRTUAL_DURABLE_OBJECTS}`);
    expect(load(`\0${VIRTUAL_DURABLE_OBJECTS}`)).toMatch(/^export \* from ".*durable-objects/);
    expect(resolveId('./src/root.tsx')).toBeNull();
    expect(load('/src/root.tsx')).toBeNull();
  });

  it('runs the dev pipeline unless it is turned off', () => {
    const use: unknown[] = [];
    const server = { middlewares: { use: (fn: unknown) => use.push(fn) } };
    const on = hypdriv()[3] as Plugin & Record<string, Hook>;
    (on.configureServer as unknown as (s: unknown) => unknown)(server);
    expect(use).toHaveLength(1);
    const off = hypdriv({ dev: false })[3] as Plugin & Record<string, Hook>;
    (off.configureServer as unknown as (s: unknown) => unknown)(server);
    expect(use).toHaveLength(1);
  });
});

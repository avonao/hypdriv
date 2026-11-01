import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hypdriv, mergeRoutes, VIRTUAL_DURABLE_OBJECTS } from './plugin';

const created: string[] = [];

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-rwsdk-plugin-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

type Hook = (...args: never[]) => unknown;

function plugins(options: Parameters<typeof hypdriv>[0] = {}) {
  const list = hypdriv(options);
  const byName = (name: string) => list.find((p) => p.name === name) as Plugin & Record<string, Hook>;
  return { list, entry: byName('hypdriv:rwsdk-entry'), build: byName('hypdriv:rwsdk-build') };
}

const resolved = (root: string, base = '/') =>
  ({
    root,
    base,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    plugins: [],
  }) as never;

type Transform = (this: unknown, code: string, id: string) => { code: string; map: null } | null;

describe('route options', () => {
  const discovered = [
    { kind: 'page' as const, pathname: '/', sourcePage: 'src/worker.tsx' },
    { kind: 'page' as const, pathname: '/docs', sourcePage: 'src/worker.tsx' },
  ];

  it('keeps the discovered routes without an option', () => {
    expect(mergeRoutes(discovered, undefined)).toBe(discovered);
  });

  it('adds listed routes and lets a listed route replace the discovered one', () => {
    const merged = mergeRoutes(discovered, [
      { kind: 'page', pathname: '/docs', prerendered: true },
      { kind: 'endpoint', pathname: '/feed' },
    ]);
    expect(merged.map((r) => `${r.kind}:${r.pathname}`)).toEqual(['page:/', 'page:/docs', 'endpoint:/feed']);
    expect(merged.find((r) => r.pathname === '/docs')?.prerendered).toBe(true);
  });

  it('lets a function decide the final list', () => {
    expect(mergeRoutes(discovered, (found) => found.slice(0, 1))).toEqual(discovered.slice(0, 1));
  });
});

describe('Hypdriv plugins', () => {
  it('registers the host, entry and build plugins in that order', () => {
    const { list, entry, build } = plugins();
    expect(list.map((p) => p.name)).toEqual(['hypdriv:rwsdk', 'hypdriv:rwsdk-entry', 'hypdriv:rwsdk-build']);
    expect(entry.enforce).toBe('pre');
    expect(build.apply).toBe('build');
    expect(build.enforce).toBe('post');
    // After RedwoodSDK's own `buildApp` (its worker, SSR, client and linker passes).
    expect((build.buildApp as unknown as { order: string }).order).toBe('post');
  });

  it('bundles the integration into every server environment and leaves the client alone', () => {
    const { entry } = plugins();
    const configEnvironment = entry.configEnvironment as unknown as (
      name: string,
      environment: { consumer: string },
    ) => unknown;
    expect(configEnvironment('client', { consumer: 'client' })).toEqual({});
    for (const name of ['worker', 'ssr'])
      expect(configEnvironment(name, { consumer: 'server' })).toEqual({
        resolve: { noExternal: ['@hypdriv/rwsdk'] },
        optimizeDeps: { exclude: ['@hypdriv/rwsdk'] },
      });
  });

  describe('the Durable Object exports', () => {
    const worker = { environment: { name: 'worker' } };

    it('are appended to the Worker entry of the worker environment, once', () => {
      const root = project({ 'src/worker.tsx': 'export default {};\n' });
      const { entry } = plugins();
      (entry.configResolved as unknown as (c: unknown) => void)(resolved(root));
      const transform = entry.transform as unknown as Transform;
      const id = join(root, 'src/worker.tsx');
      const out = transform.call(worker, 'export default {};', id);
      expect(out?.code).toContain(`export * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)}`);
      expect(out?.code.startsWith('export default {};')).toBe(true);
      // Already exported: nothing to add.
      expect(transform.call(worker, out?.code ?? '', id)).toBeNull();
      // A query on the id (Vite adds them) is the same module.
      expect(transform.call(worker, 'export default {};', `${id}?v=1`)?.code).toContain('durable-objects');
    });

    it('are not added to other files or other environments', () => {
      const root = project({ 'src/worker.tsx': 'export default {};\n' });
      const { entry } = plugins();
      (entry.configResolved as unknown as (c: unknown) => void)(resolved(root));
      const transform = entry.transform as unknown as Transform;
      expect(transform.call(worker, 'x', join(root, 'src/other.ts'))).toBeNull();
      expect(transform.call({ environment: { name: 'ssr' } }, 'x', join(root, 'src/worker.tsx'))).toBeNull();
      expect(
        transform.call({ environment: { name: 'client' } }, 'x', join(root, 'src/worker.tsx')),
      ).toBeNull();
      expect(transform.call({}, 'x', join(root, 'src/worker.tsx'))).toBeNull();
    });

    it('follow the entry option and the Wrangler main', () => {
      const root = project({ 'src/custom.tsx': '', 'src/server.tsx': '' });
      const custom = plugins({ entry: 'src/custom.tsx' }).entry;
      (custom.configResolved as unknown as (c: unknown) => void)(resolved(root));
      expect(
        (custom.transform as unknown as Transform).call(worker, 'x', join(root, 'src/custom.tsx')),
      ).not.toBeNull();
      expect(
        (custom.transform as unknown as Transform).call(worker, 'x', join(root, 'src/worker.tsx')),
      ).toBeNull();

      const wrangler = project({ 'wrangler.jsonc': '{ "main": "src/server.tsx" }', 'src/server.tsx': '' });
      const main = plugins().entry;
      (main.configResolved as unknown as (c: unknown) => void)(resolved(wrangler));
      expect(
        (main.transform as unknown as Transform).call(worker, 'x', join(wrangler, 'src/server.tsx')),
      ).not.toBeNull();
    });

    it('can be switched off', () => {
      const root = project({ 'src/worker.tsx': '' });
      const { entry } = plugins({ durableObjects: false });
      (entry.configResolved as unknown as (c: unknown) => void)(resolved(root));
      expect(
        (entry.transform as unknown as Transform).call(worker, 'x', join(root, 'src/worker.tsx')),
      ).toBeNull();
    });

    it('come from a virtual module that re-exports the package’s classes', () => {
      const { entry } = plugins();
      (entry.configResolved as unknown as (c: unknown) => void)(resolved(project()));
      const resolveId = entry.resolveId as unknown as (id: string) => string | null;
      const load = entry.load as unknown as (id: string) => string | null;
      expect(resolveId(VIRTUAL_DURABLE_OBJECTS)).toBe(`\0${VIRTUAL_DURABLE_OBJECTS}`);
      expect(resolveId('./src/pages/index.tsx')).toBeNull();
      expect(load(`\0${VIRTUAL_DURABLE_OBJECTS}`)).toMatch(/^export \* from ".*durable-objects.*";\n$/);
      expect(load('/src/pages/index.tsx')).toBeNull();
    });
  });

  describe('the build step', () => {
    it('says what to add when the build has no worker environment', async () => {
      const { entry, build } = plugins();
      (entry.configResolved as unknown as (c: unknown) => void)(resolved(project()));
      const handler = (build.buildApp as unknown as { handler: (builder: unknown) => Promise<void> }).handler;
      await expect(handler({ environments: { client: {} } })).rejects.toThrow(
        /no `worker` environment.*cloudflare\(\{ viteEnvironment: \{ name: 'worker' \} \}\)/,
      );
    });

    it('does nothing before the config is resolved', async () => {
      const { build } = plugins();
      const handler = (build.buildApp as unknown as { handler: (builder: unknown) => Promise<void> }).handler;
      await expect(handler({ environments: {} })).resolves.toBeUndefined();
    });
  });
});
